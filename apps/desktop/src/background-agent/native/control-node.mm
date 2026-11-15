#include "control-node.h"
#include "control-socket.h"
#include "control-stream.h"
#include <cerrno>
#include <cstring>
#include <cstdlib>
#include <limits.h>
#include <memory>
#include <mutex>
#include <unordered_set>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

namespace koed {
namespace {
enum class HandleKind { Listener, Connection };
struct Handle {
  explicit Handle(HandleKind kind) : kind(kind) {}
  virtual ~Handle() = default;
  const HandleKind kind;
};
struct Listener : Handle {
  Listener() : Handle(HandleKind::Listener) {}
  ~Listener() override { closeControlListener(&listener); }
  ControlListener listener;
};
struct Connection : Handle {
  explicit Connection(int fd) : Handle(HandleKind::Connection), fd(fd), stream(fd) {}
  ~Connection() override { if (fd >= 0) close(fd); }
  int fd;
  bool authenticated = false;
  ControlPeer peer{};
  ControlStream stream;
};

std::mutex &registryMutex() { static auto *value = new std::mutex; return *value; }
std::unordered_set<Handle *> &registry() {
  static auto *value = new std::unordered_set<Handle *>;
  return *value;
}
bool registered(Handle *handle) {
  std::lock_guard<std::mutex> lock(registryMutex());
  return registry().find(handle) != registry().end();
}

Napi::Value fail(Napi::Env env, const char *message) {
  Napi::Error::New(env, message).ThrowAsJavaScriptException();
  return env.Undefined();
}
Handle *handle(const Napi::CallbackInfo &info, HandleKind kind) {
  if (info.Length() == 0 || !info[0].IsExternal()) {
    fail(info.Env(), "Invalid local control handle"); return nullptr;
  }
  auto *value = info[0].As<Napi::External<Handle>>().Data();
  if (!value || !registered(value) || value->kind != kind) {
    fail(info.Env(), "Invalid local control handle"); return nullptr;
  }
  return value;
}
Napi::Value external(Napi::Env env, Handle *value) {
  { std::lock_guard<std::mutex> lock(registryMutex()); registry().insert(value); }
  return Napi::External<Handle>::New(env, value, [](Napi::Env, Handle *handle) {
    { std::lock_guard<std::mutex> lock(registryMutex()); registry().erase(handle); }
    delete handle;
  });
}
Napi::Object peerObject(Napi::Env env, const ControlPeer &peer) {
  auto result = Napi::Object::New(env);
  result.Set("pid", Napi::Number::New(env, peer.pid));
  result.Set("uid", Napi::Number::New(env, peer.uid));
  return result;
}
bool privateParent(const std::string &path) {
  auto slash = path.rfind('/');
  if (slash == std::string::npos || slash == 0) return false;
  std::string parent = path.substr(0, slash);
  struct stat info{};
  char resolved[PATH_MAX];
  return lstat(parent.c_str(), &info) == 0 && S_ISDIR(info.st_mode) &&
    info.st_uid == geteuid() && (info.st_mode & 077) == 0 &&
    realpath(parent.c_str(), resolved) && parent == resolved;
}
Napi::Value listen(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  if (info.Length() != 1 || !info[0].IsString()) return fail(env, "Invalid local control path");
  auto path = info[0].As<Napi::String>().Utf8Value();
  if (!privateParent(path)) return fail(env, "Local control directory is not private");
  auto requirement = createProductionControlPeerRequirement();
  if (!requirement) return fail(env, "Local control signing policy unavailable");
  CFRelease(requirement);
  auto listener = std::make_unique<Listener>();
  if (!openControlListener(path, &listener->listener)) return fail(env, "Unable to open local control listener");
  return external(env, listener.release());
}
Napi::Value accept(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  auto *listener = static_cast<Listener *>(handle(info, HandleKind::Listener));
  if (!listener) return env.Undefined();
  if (listener->listener.fd < 0) return fail(env, "Local control listener is closed");
  auto requirement = createProductionControlPeerRequirement();
  if (!requirement) return fail(env, "Local control signing policy unavailable");
  ControlPeer peer{};
  int fd = acceptControlSocket(listener->listener.fd, requirement, &peer);
  CFRelease(requirement);
  if (fd < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EACCES) return env.Null();
    return fail(env, "Local control peer was not accepted");
  }
  auto connection = std::make_unique<Connection>(fd);
  if (!connection->stream.ready()) return fail(env, "Unable to initialize local control stream");
  connection->authenticated = true;
  connection->peer = peer;
  return external(env, connection.release());
}
Napi::Value connect(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  if (info.Length() != 1 || !info[0].IsString()) return fail(env, "Invalid local control path");
  auto path = info[0].As<Napi::String>().Utf8Value();
  if (!privateParent(path)) return fail(env, "Local control directory is not private");
  int fd = connectControlSocket(path);
  if (fd < 0) return fail(env, "Unable to connect local control socket");
  auto connection = std::make_unique<Connection>(fd);
  if (!connection->stream.ready()) return fail(env, "Unable to initialize local control stream");
  return external(env, connection.release());
}
Napi::Value finishConnect(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  auto *connection = static_cast<Connection *>(handle(info, HandleKind::Connection));
  if (!connection) return env.Undefined();
  if (connection->fd < 0) return fail(env, "Local control connection is closed");
  if (connection->authenticated) return peerObject(env, connection->peer);
  int error = 0; socklen_t errorSize = sizeof(error);
  if (getsockopt(connection->fd, SOL_SOCKET, SO_ERROR, &error, &errorSize) != 0 || error != 0)
    return fail(env, "Local control connection failed");
  sockaddr_un address{}; socklen_t size = sizeof(address);
  if (getpeername(connection->fd, reinterpret_cast<sockaddr *>(&address), &size) != 0) {
    if (errno == ENOTCONN || errno == EINPROGRESS) return env.Null();
    return fail(env, "Local control connection failed");
  }
  auto requirement = createProductionControlPeerRequirement();
  if (!requirement) return fail(env, "Local control signing policy unavailable");
  bool valid = authenticateConnectedControlSocket(connection->fd, requirement, &connection->peer);
  CFRelease(requirement);
  if (!valid) return fail(env, "Local control peer authentication failed");
  connection->authenticated = true;
  return peerObject(env, connection->peer);
}
Connection *authenticated(const Napi::CallbackInfo &info) {
  auto *connection = static_cast<Connection *>(handle(info, HandleKind::Connection));
  if (!connection) return nullptr;
  if (connection->fd < 0 || !connection->authenticated) {
    fail(info.Env(), "Local control connection is not authenticated"); return nullptr;
  }
  return connection;
}
Napi::Value read(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  auto *connection = authenticated(info);
  if (!connection) return env.Undefined();
  std::vector<std::string> messages;
  auto status = connection->stream.readAvailable(&messages);
  if (status == ControlReadResult::Error || status == ControlReadResult::TruncatedEof)
    return fail(env, "Local control stream read failed");
  auto frames = Napi::Array::New(env, messages.size());
  for (size_t i = 0; i < messages.size(); ++i) frames.Set(i, Napi::String::New(env, messages[i]));
  auto result = Napi::Object::New(env);
  result.Set("messages", frames);
  result.Set("more", Napi::Boolean::New(env, status == ControlReadResult::MoreAvailable));
  result.Set("eof", Napi::Boolean::New(env, status == ControlReadResult::CleanEof));
  return result;
}
Napi::Value write(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  auto *connection = authenticated(info);
  if (!connection) return env.Undefined();
  if (info.Length() != 2 || !info[1].IsString()) return fail(env, "Invalid local control frame");
  if (!connection->stream.queue(info[1].As<Napi::String>().Utf8Value()))
    return fail(env, "Local control write queue is full or frame is invalid");
  return env.Undefined();
}
Napi::Value flush(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  auto *connection = authenticated(info);
  if (!connection) return env.Undefined();
  if (!connection->stream.flush()) return fail(env, "Local control stream write failed");
  return Napi::Boolean::New(env, !connection->stream.hasPendingWrites());
}
Napi::Value closeHandle(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  if (info.Length() != 1 || !info[0].IsExternal()) return fail(env, "Invalid local control handle");
  auto *value = info[0].As<Napi::External<Handle>>().Data();
  if (!value || !registered(value)) return fail(env, "Invalid local control handle");
  if (value->kind == HandleKind::Listener) closeControlListener(&static_cast<Listener *>(value)->listener);
  else {
    auto *connection = static_cast<Connection *>(value);
    if (connection->fd >= 0) { close(connection->fd); connection->fd = -1; }
  }
  return env.Undefined();
}
}
Napi::Object createLocalControlBinding(Napi::Env env) {
  auto binding = Napi::Object::New(env);
  binding.Set("listen", Napi::Function::New(env, listen));
  binding.Set("accept", Napi::Function::New(env, accept));
  binding.Set("connect", Napi::Function::New(env, connect));
  binding.Set("finishConnect", Napi::Function::New(env, finishConnect));
  binding.Set("read", Napi::Function::New(env, read));
  binding.Set("write", Napi::Function::New(env, write));
  binding.Set("flush", Napi::Function::New(env, flush));
  binding.Set("close", Napi::Function::New(env, closeHandle));
  return binding;
}
}
