#include <napi.h>

#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#ifdef KOED_SIGNING_TEAM_ID
#define KOED_STRINGIFY_INNER(value) #value
#define KOED_STRINGIFY(value) KOED_STRINGIFY_INNER(value)
#define KOED_SIGNING_TEAM_ID_VALUE KOED_STRINGIFY(KOED_SIGNING_TEAM_ID)
#else
#define KOED_SIGNING_TEAM_ID_VALUE ""
#endif

@protocol KoedBackgroundAgentXpc
- (void)request:(NSString *)payload reply:(void (^)(NSString *))reply;
@end

namespace {

constexpr uint32_t maxActiveConnections = 16;
constexpr uint32_t maxPendingRequests = 64;
constexpr size_t maxPayloadBytes = 65'536;

struct ServerState;
struct ClientRequestState;

struct ServerEvent {
  enum class Kind { Request, Disconnect };
  Kind kind;
  std::string connectionId;
  std::string payload;
  uint64_t replyId = 0;
  std::shared_ptr<ServerState> state;
};

struct PendingReply {
  std::string serverId;
  std::string connectionId;
  __strong void (^reply)(NSString *) = nil;
};

struct ClientResponse {
  std::shared_ptr<ClientRequestState> state;
  bool failed;
  std::string value;
};

struct ClientRequestState {
  explicit ClientRequestState(Napi::Promise::Deferred promise)
      : deferred(std::move(promise)) {}
  Napi::Promise::Deferred deferred;
  std::atomic<bool> settled{false};
};

struct ServerState {
  std::mutex mutex;
  std::atomic<bool> closed{false};
  std::atomic<uint32_t> activeConnections{0};
  std::atomic<uint32_t> pendingRequests{0};
  bool released = false;
  std::string serverId;
  std::string codeRequirement;
  Napi::FunctionReference onRequest;
  Napi::FunctionReference onDisconnect;
  Napi::ThreadSafeFunction events;
  __strong NSXPCListener *listener = nil;
  __strong id<NSXPCListenerDelegate> delegate = nil;
};

std::mutex pendingRepliesMutex;
std::unordered_map<uint64_t, PendingReply> pendingReplies;
std::atomic<uint64_t> nextReplyId{1};
Napi::FunctionReference serverConstructor;
Napi::FunctionReference connectionConstructor;

NSString *toNSString(const std::string &value) {
  NSString *result = [[NSString alloc] initWithBytes:value.data()
                                              length:value.size()
                                            encoding:NSUTF8StringEncoding];
  return result ?: @"";
}

std::string toUtf8(NSString *value) {
  const char *utf8 = value.UTF8String;
  return utf8 == nullptr ? std::string() : std::string(utf8);
}

void completeReply(uint64_t replyId, NSString *response) {
  PendingReply pending;
  {
    std::lock_guard<std::mutex> lock(pendingRepliesMutex);
    auto iterator = pendingReplies.find(replyId);
    if (iterator == pendingReplies.end()) return;
    pending = iterator->second;
    pendingReplies.erase(iterator);
  }
  if (pending.reply != nil) pending.reply(response ?: @"");
}

uint64_t storeReply(const std::string &serverId,
                    const std::string &connectionId,
                    void (^reply)(NSString *)) {
  const uint64_t replyId = nextReplyId.fetch_add(1);
  std::lock_guard<std::mutex> lock(pendingRepliesMutex);
  pendingReplies.emplace(replyId,
                         PendingReply{serverId, connectionId, reply});
  return replyId;
}

void completeRepliesFor(const std::string &serverId,
                        const std::string &connectionId) {
  std::vector<PendingReply> replies;
  {
    std::lock_guard<std::mutex> lock(pendingRepliesMutex);
    for (auto iterator = pendingReplies.begin();
         iterator != pendingReplies.end();) {
      const bool matchesServer = iterator->second.serverId == serverId;
      const bool matchesConnection = connectionId.empty() ||
                                     iterator->second.connectionId == connectionId;
      if (matchesServer && matchesConnection) {
        replies.push_back(iterator->second);
        iterator = pendingReplies.erase(iterator);
      } else {
        ++iterator;
      }
    }
  }
  for (const auto &pending : replies) {
    if (pending.reply != nil) pending.reply(@"");
  }
}

Napi::Value replyToXpc(const Napi::CallbackInfo &info) {
  auto *replyId = static_cast<uint64_t *>(info.Data());
  if (replyId == nullptr || info.Length() != 1 || !info[0].IsString()) {
    Napi::TypeError::New(info.Env(), "XPC reply must be a string.")
        .ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  const std::string response = info[0].As<Napi::String>().Utf8Value();
  completeReply(*replyId, toNSString(response));
  return info.Env().Undefined();
}

Napi::Function createReplyFunction(Napi::Env env, uint64_t replyId) {
  auto *context = new uint64_t(replyId);
  auto external = Napi::External<uint64_t>::New(
      env, context, [](Napi::Env, uint64_t *data) { delete data; });
  auto function = Napi::Function::New(env, replyToXpc, "reply", context);
  function.Set("_koedNativeReplyContext", external);
  return function;
}

void callServerEvent(Napi::Env env,
                     Napi::Function,
                     ServerEvent *event) {
  std::unique_ptr<ServerEvent> eventGuard(event);
  if (event == nullptr) return;
  if (env == nullptr || !event->state) {
    if (event->replyId != 0) completeReply(event->replyId, @"");
    return;
  }

  const auto &state = *event->state;
  if (state.closed.load()) {
    if (event->replyId != 0) completeReply(event->replyId, @"");
    return;
  }
  const auto connectionId = Napi::String::New(env, event->connectionId);
  if (event->kind == ServerEvent::Kind::Disconnect) {
    state.onDisconnect.Call({connectionId});
    return;
  }
  state.onRequest.Call({connectionId,
                        Napi::String::New(env, event->payload),
                        createReplyFunction(env, event->replyId)});
}

void enqueueServerEvent(const std::shared_ptr<ServerState> &state,
                        ServerEvent *event) {
  event->state = state;
  napi_status status = napi_closing;
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    if (!state->closed.load())
      status = state->events.NonBlockingCall(event, callServerEvent);
  }
  if (status != napi_ok) {
    if (event->replyId != 0) completeReply(event->replyId, @"");
    delete event;
  }
}

void closeServer(const std::shared_ptr<ServerState> &state) {
  if (!state) return;
  __strong NSXPCListener *listener = nil;
  {
    std::lock_guard<std::mutex> lock(state->mutex);
    if (state->closed.exchange(true)) return;
    listener = state->listener;
    state->listener.delegate = nil;
    state->listener = nil;
    state->delegate = nil;
    if (!state->released) {
      state->released = true;
      state->events.Release();
    }
  }
  [listener invalidate];
  completeRepliesFor(state->serverId, "");
  state->onRequest.Reset();
  state->onDisconnect.Reset();
}

}  // namespace

@interface KoedAgentRequestHandler : NSObject <KoedBackgroundAgentXpc> {
 @private
  std::shared_ptr<ServerState> _state;
  std::string _connectionId;
}
- (instancetype)initWithState:(std::shared_ptr<ServerState>)state
                 connectionId:(std::string)connectionId;
@end

@interface KoedAgentListenerDelegate : NSObject <NSXPCListenerDelegate> {
 @private
  std::weak_ptr<ServerState> _state;
}
- (instancetype)initWithState:(std::shared_ptr<ServerState>)state;
@end

namespace {

class ServerHandle : public Napi::ObjectWrap<ServerHandle> {
 public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(env, "AgentListener",
                       {InstanceMethod("close", &ServerHandle::Close)});
  }

  explicit ServerHandle(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<ServerHandle>(info) {
    Napi::Env env = info.Env();
    if (info.Length() != 4 || !info[0].IsString() || !info[1].IsString() ||
        !info[2].IsFunction() || !info[3].IsFunction()) {
      Napi::TypeError::New(env, "Invalid Background Agent listener arguments.")
          .ThrowAsJavaScriptException();
      return;
    }
    state_ = std::make_shared<ServerState>();
    state_->serverId = toUtf8([[NSUUID UUID] UUIDString]);
    state_->codeRequirement = info[1].As<Napi::String>().Utf8Value();
    state_->onRequest = Napi::Persistent(info[2].As<Napi::Function>());
    state_->onDisconnect = Napi::Persistent(info[3].As<Napi::Function>());
    if (!startListener(env, info[0].As<Napi::String>().Utf8Value())) {
      closeServer(state_);
      state_.reset();
    }
  }

  ~ServerHandle() override { closeServer(state_); }

  Napi::Value Close(const Napi::CallbackInfo &info) {
    closeServer(state_);
    return info.Env().Undefined();
  }

 private:
  bool startListener(Napi::Env env, const std::string &serviceName) {
    state_->events = Napi::ThreadSafeFunction::New(
        env, Napi::Function::New(env, [](const Napi::CallbackInfo &) {}),
        "Koed Background Agent XPC events", maxPendingRequests, 1);
    @try {
      state_->listener =
          [[NSXPCListener alloc] initWithMachServiceName:toNSString(serviceName)];
      [state_->listener setDelegate:
          [[KoedAgentListenerDelegate alloc] initWithState:state_]];
      state_->delegate = state_->listener.delegate;
      [state_->listener resume];
      return true;
    } @catch (NSException *exception) {
      Napi::Error::New(env, toUtf8(exception.reason).c_str())
          .ThrowAsJavaScriptException();
      return false;
    }
  }

  std::shared_ptr<ServerState> state_;
};

uint64_t storeRequestReply(const std::shared_ptr<ServerState> &state,
                           const std::string &connectionId,
                           void (^reply)(NSString *)) {
  return storeReply(state->serverId, connectionId, reply);
}

void handleServerRequest(const std::shared_ptr<ServerState> &state,
                         const std::string &connectionId,
                         NSString *payload,
                         void (^reply)(NSString *)) {
  if ([payload lengthOfBytesUsingEncoding:NSUTF8StringEncoding] >
      maxPayloadBytes) {
    reply(@"");
    return;
  }
  const auto pending = state->pendingRequests.fetch_add(1);
  if (pending >= maxPendingRequests) {
    state->pendingRequests.fetch_sub(1);
    reply(@"");
    return;
  }
  auto completed = std::make_shared<std::atomic<bool>>(false);
  void (^boundedReply)(NSString *) = ^(NSString *response) {
    if (completed->exchange(true)) return;
    state->pendingRequests.fetch_sub(1);
    if (reply != nil) reply(response ?: @"");
  };
  const auto requestId = storeRequestReply(state, connectionId, boundedReply);
  auto *event = new ServerEvent{ServerEvent::Kind::Request,
                                connectionId,
                                toUtf8(payload),
                                requestId,
                                nullptr};
  enqueueServerEvent(state, event);
  dispatch_after(
      dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC),
      dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        completeReply(requestId, @"");
      });
}

}  // namespace

@implementation KoedAgentRequestHandler
- (instancetype)initWithState:(std::shared_ptr<ServerState>)state
                 connectionId:(std::string)connectionId {
  self = [super init];
  if (self) {
    _state = std::move(state);
    _connectionId = std::move(connectionId);
  }
  return self;
}

- (void)request:(NSString *)payload reply:(void (^)(NSString *))reply {
  handleServerRequest(_state, _connectionId, payload, reply);
}
@end

@implementation KoedAgentListenerDelegate
- (instancetype)initWithState:(std::shared_ptr<ServerState>)state {
  self = [super init];
  if (self) _state = state;
  return self;
}

- (BOOL)listener:(NSXPCListener *)listener
    shouldAcceptNewConnection:(NSXPCConnection *)connection {
  auto state = _state.lock();
  if (!state || state->closed.load()) return NO;
  @try {
    [connection setCodeSigningRequirement:
        toNSString(state->codeRequirement)];
  } @catch (NSException *) {
    return NO;
  }

  const auto active = state->activeConnections.fetch_add(1);
  if (active >= maxActiveConnections) {
    state->activeConnections.fetch_sub(1);
    [connection invalidate];
    return NO;
  }

  const std::string connectionId = toUtf8([[NSUUID UUID] UUIDString]);
  auto disconnected = std::make_shared<std::atomic<bool>>(false);
  auto *handler = [[KoedAgentRequestHandler alloc]
      initWithState:state
       connectionId:connectionId];
  connection.exportedInterface =
      [NSXPCInterface interfaceWithProtocol:@protocol(KoedBackgroundAgentXpc)];
  connection.exportedObject = handler;
  connection.invalidationHandler = ^{
    if (disconnected->exchange(true)) return;
    state->activeConnections.fetch_sub(1);
    completeRepliesFor(state->serverId, connectionId);
    enqueueServerEvent(
        state, new ServerEvent{ServerEvent::Kind::Disconnect, connectionId, "", 0,
                               nullptr});
  };
  @try {
    [connection resume];
    return YES;
  } @catch (NSException *) {
    if (!disconnected->exchange(true)) state->activeConnections.fetch_sub(1);
    [connection invalidate];
    return NO;
  }
}
@end

namespace {

void callClientResponse(Napi::Env env,
                        Napi::Function,
                        ClientResponse *response) {
  std::unique_ptr<ClientResponse> responseGuard(response);
  if (env == nullptr || response == nullptr || !response->state) return;
  auto &deferred = response->state->deferred;
  if (response->failed) {
    deferred.Reject(Napi::Error::New(env, response->value).Value());
  } else {
    deferred.Resolve(Napi::String::New(env, response->value));
  }
}

Napi::Value noOp(const Napi::CallbackInfo &info) {
  return info.Env().Undefined();
}

bool readBoundedUtf8(Napi::Env env, Napi::Value value, std::string &output) {
  size_t byteLength = 0;
  auto status = napi_get_value_string_utf8(env, value, nullptr, 0, &byteLength);
  if (status != napi_ok) {
    Napi::TypeError::New(env, "Background Agent request must be UTF-8 text.")
        .ThrowAsJavaScriptException();
    return false;
  }
  if (byteLength > maxPayloadBytes) {
    Napi::RangeError::New(env, "Background Agent request exceeds the size limit.")
        .ThrowAsJavaScriptException();
    return false;
  }
  std::vector<char> buffer(byteLength + 1);
  size_t copiedLength = 0;
  status = napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(),
                                      &copiedLength);
  if (status != napi_ok) {
    Napi::TypeError::New(env, "Background Agent request must be UTF-8 text.")
        .ThrowAsJavaScriptException();
    return false;
  }
  output.assign(buffer.data(), copiedLength);
  return true;
}

class ConnectionHandle : public Napi::ObjectWrap<ConnectionHandle> {
 public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(env, "AgentConnection",
                       {InstanceMethod("close", &ConnectionHandle::Close),
                        InstanceMethod("request", &ConnectionHandle::Request)});
  }

  explicit ConnectionHandle(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<ConnectionHandle>(info) {
    Napi::Env env = info.Env();
    if (info.Length() != 2 || !info[0].IsString() || !info[1].IsString()) {
      Napi::TypeError::New(env, "Invalid Background Agent connection arguments.")
          .ThrowAsJavaScriptException();
      return;
    }
    const std::string serviceName = info[0].As<Napi::String>().Utf8Value();
    const std::string requirement = info[1].As<Napi::String>().Utf8Value();
    @try {
      connection_ = [[NSXPCConnection alloc]
          initWithMachServiceName:toNSString(serviceName)
                          options:0];
      [connection_ setCodeSigningRequirement:toNSString(requirement)];
      connection_.remoteObjectInterface =
          [NSXPCInterface interfaceWithProtocol:@protocol(KoedBackgroundAgentXpc)];
      [connection_ resume];
    } @catch (NSException *exception) {
      connection_ = nil;
      Napi::Error::New(env, toUtf8(exception.reason).c_str())
          .ThrowAsJavaScriptException();
    }
  }

  ~ConnectionHandle() override { closeConnection(); }

  Napi::Value Close(const Napi::CallbackInfo &info) {
    closeConnection();
    return info.Env().Undefined();
  }

  Napi::Value Request(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (closed_ || connection_ == nil) {
      Napi::Error::New(env, "Background Agent XPC connection is closed.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    if (info.Length() != 2 || !info[0].IsString() || !info[1].IsNumber()) {
      Napi::TypeError::New(env, "Invalid Background Agent request arguments.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    std::string payload;
    if (!readBoundedUtf8(env, info[0], payload)) return env.Undefined();
    const int timeoutMs = info[1].As<Napi::Number>().Int32Value();
    if (timeoutMs < 1 || timeoutMs > 60000) {
      Napi::RangeError::New(env, "Background Agent timeout is out of range.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    return sendRequest(env, payload, timeoutMs);
  }

 private:
  Napi::Value sendRequest(Napi::Env env,
                          const std::string &payload,
                          int timeoutMs) {
    const auto pending = pendingRequests_->fetch_add(1);
    if (pending >= maxPendingRequests) {
      pendingRequests_->fetch_sub(1);
      Napi::Error::New(env, "Background Agent XPC request limit reached.")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    auto deferred = Napi::Promise::Deferred::New(env);
    auto promise = deferred.Promise();
    auto state = std::make_shared<ClientRequestState>(std::move(deferred));
    auto threadSafe = Napi::ThreadSafeFunction::New(
        env, Napi::Function::New(env, noOp), "Koed Background Agent XPC reply",
        1, 1);
    auto pendingRequests = pendingRequests_;
    auto complete = [state, threadSafe, pendingRequests](std::string value,
                                                        bool failed) mutable {
      if (state->settled.exchange(true)) return;
      pendingRequests->fetch_sub(1);
      auto *response = new ClientResponse{state, failed, std::move(value)};
      const auto status = threadSafe.NonBlockingCall(response, callClientResponse);
      if (status != napi_ok) delete response;
      threadSafe.Release();
    };
    sendPayload(payload, timeoutMs, complete);
    return promise;
  }

  void sendPayload(const std::string &payload,
                   int timeoutMs,
                   std::function<void(std::string, bool)> complete) {
    __strong NSXPCConnection *activeConnection = connection_;
    id<KoedBackgroundAgentXpc> proxy = [activeConnection
        remoteObjectProxyWithErrorHandler:^(NSError *error) {
          complete(toUtf8(error.localizedDescription), true);
        }];
    [proxy request:toNSString(payload)
        reply:^(NSString *response) { complete(toUtf8(response), false); }];
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW,
                      static_cast<int64_t>(timeoutMs) * NSEC_PER_MSEC),
        dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
          complete("Background Agent XPC request timed out.", true);
        });
  }

  void closeConnection() {
    if (closed_) return;
    closed_ = true;
    __strong NSXPCConnection *connection = connection_;
    connection_ = nil;
    [connection invalidate];
  }

  __strong NSXPCConnection *connection_ = nil;
  std::shared_ptr<std::atomic<uint32_t>> pendingRequests_ =
      std::make_shared<std::atomic<uint32_t>>(0);
  bool closed_ = false;
};

Napi::Value listen(const Napi::CallbackInfo &info) {
  if (serverConstructor.IsEmpty()) {
    Napi::Error::New(info.Env(), "Background Agent listener is unavailable.")
        .ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  return serverConstructor.New({info[0], info[1], info[2], info[3]});
}

Napi::Value connect(const Napi::CallbackInfo &info) {
  if (connectionConstructor.IsEmpty()) {
    Napi::Error::New(info.Env(), "Background Agent connection is unavailable.")
        .ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  return connectionConstructor.New({info[0], info[1]});
}

Napi::Object initialize(Napi::Env env, Napi::Object exports) {
  serverConstructor = Napi::Persistent(ServerHandle::Define(env));
  connectionConstructor = Napi::Persistent(ConnectionHandle::Define(env));
  exports.Set("listen", Napi::Function::New(env, listen));
  exports.Set("connect", Napi::Function::New(env, connect));
  exports.Set("teamId", Napi::String::New(env, KOED_SIGNING_TEAM_ID_VALUE));
  auto limits = Napi::Object::New(env);
  limits.Set("maxPayloadBytes", Napi::Number::New(env, maxPayloadBytes));
  limits.Set("maxPendingRequests", Napi::Number::New(env, maxPendingRequests));
  limits.Set("maxConnections", Napi::Number::New(env, maxActiveConnections));
  exports.Set("limits", limits);
  return exports;
}

}  // namespace

NODE_API_MODULE(koed_background_xpc, initialize)
