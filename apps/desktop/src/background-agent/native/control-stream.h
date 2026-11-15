#pragma once

#include "control-frame.h"
#include <deque>
#include <string>
#include <vector>

namespace koed {
// MoreAvailable means the caller must schedule another read without waiting
// for a new readiness edge; the descriptor may still contain unread frames.
enum class ControlReadResult { Open, MoreAvailable, CleanEof, TruncatedEof, Error };

// Non-owning: the caller retains and closes the authenticated descriptor.
class ControlStream {
 public:
  explicit ControlStream(int fd);
  bool ready() const { return ready_; }
  ControlStream(const ControlStream &) = delete;
  ControlStream &operator=(const ControlStream &) = delete;
  bool queue(const std::string &message);
  bool flush();
  ControlReadResult readAvailable(std::vector<std::string> *messages);
  bool hasPendingWrites() const { return !outgoing_.empty(); }
 private:
  int fd_;
  bool ready_ = false;
  ControlFrameDecoder decoder_;
  std::deque<std::string> outgoing_;
  size_t written_ = 0;
};
}
