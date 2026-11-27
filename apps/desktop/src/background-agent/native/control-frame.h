#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace koed {
constexpr size_t kControlMaxFrameBytes = 65536;
constexpr size_t kControlMaxFramesPerRead = 64;

// A false result is terminal: callers discard output and close the connection.
class ControlFrameDecoder {
 public:
  bool feed(const uint8_t *bytes, size_t length, std::vector<std::string> *frames);
  bool atFrameBoundary() const { return headerSize_ == 0 && expected_ == 0; }
  size_t bytesUntilBoundary() const {
    return headerSize_ < sizeof(header_) ? sizeof(header_) - headerSize_ : expected_ - body_.size();
  }
 private:
  uint8_t header_[4]{};
  size_t headerSize_ = 0;
  size_t expected_ = 0;
  std::string body_;
  bool failed_ = false;
};
}
