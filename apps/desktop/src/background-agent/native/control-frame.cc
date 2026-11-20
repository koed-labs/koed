#include "control-frame.h"
#include <algorithm>
#include <utility>

namespace koed {
bool ControlFrameDecoder::feed(const uint8_t *bytes, size_t length,
                               std::vector<std::string> *frames) {
  if (failed_ || !frames || (!bytes && length != 0)) return false;
  size_t offset = 0;
  const size_t initialCount = frames->size();
  while (offset < length) {
    if (headerSize_ < sizeof(header_)) {
      const size_t count = std::min(sizeof(header_) - headerSize_, length - offset);
      for (size_t i = 0; i < count; ++i) header_[headerSize_++] = bytes[offset++];
      if (headerSize_ < sizeof(header_)) continue;
      expected_ = (static_cast<uint32_t>(header_[0]) << 24) |
                  (static_cast<uint32_t>(header_[1]) << 16) |
                  (static_cast<uint32_t>(header_[2]) << 8) | header_[3];
      if (!expected_ || expected_ > kControlMaxFrameBytes || frames->size() - initialCount >= kControlMaxFramesPerRead) {
        failed_ = true;
        return false;
      }
      body_.clear();
      body_.reserve(expected_);
    }
    const size_t count = std::min(expected_ - body_.size(), length - offset);
    body_.append(reinterpret_cast<const char *>(bytes + offset), count);
    offset += count;
    if (body_.size() == expected_) {
      if (frames->size() - initialCount >= kControlMaxFramesPerRead) {
        failed_ = true;
        return false;
      }
      frames->push_back(std::move(body_));
      headerSize_ = 0;
      expected_ = 0;
    }
  }
  return true;
}
}
