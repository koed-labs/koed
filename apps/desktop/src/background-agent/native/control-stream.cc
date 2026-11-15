#include "control-stream.h"

#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <fcntl.h>
#include <sys/socket.h>
#include <unistd.h>

namespace koed {
ControlStream::ControlStream(int fd) : fd_(fd) {
  const int flags = fcntl(fd_, F_GETFL);
  const int noSigPipe = 1;
  ready_ = flags >= 0 && (flags & O_NONBLOCK) &&
           setsockopt(fd_, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, sizeof(noSigPipe)) == 0;
}

bool ControlStream::queue(const std::string &message) {
  if (!ready_ || message.empty() || message.size() > kControlMaxFrameBytes ||
      outgoing_.size() >= kControlMaxFramesPerRead) return false;
  const auto length = static_cast<uint32_t>(message.size());
  std::string frame(4, '\0');
  frame[0] = static_cast<char>(length >> 24);
  frame[1] = static_cast<char>(length >> 16);
  frame[2] = static_cast<char>(length >> 8);
  frame[3] = static_cast<char>(length);
  frame += message;
  outgoing_.push_back(std::move(frame));
  return true;
}

bool ControlStream::flush() {
  if (!ready_) return false;
  while (!outgoing_.empty()) {
    const std::string &frame = outgoing_.front();
    const ssize_t count = send(fd_, frame.data() + written_, frame.size() - written_, 0);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return true;
    if (count <= 0) return false;
    written_ += static_cast<size_t>(count);
    if (written_ == frame.size()) { outgoing_.pop_front(); written_ = 0; }
  }
  return true;
}

ControlReadResult ControlStream::readAvailable(std::vector<std::string> *messages) {
  if (!ready_ || !messages) { errno = EINVAL; return ControlReadResult::Error; }
  const size_t initialSize = messages->size();
  uint8_t buffer[8192];
  while (messages->size() - initialSize < kControlMaxFramesPerRead) {
    const size_t capacity = std::min(sizeof(buffer), decoder_.bytesUntilBoundary());
    const ssize_t count = recv(fd_, buffer, capacity, 0);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return ControlReadResult::Open;
    if (count < 0) return ControlReadResult::Error;
    if (count == 0) return decoder_.atFrameBoundary() ? ControlReadResult::CleanEof : ControlReadResult::TruncatedEof;
    if (!decoder_.feed(buffer, static_cast<size_t>(count), messages)) {
      errno = EMSGSIZE;
      return ControlReadResult::Error;
    }
  }
  return ControlReadResult::MoreAvailable;
}
}
