#pragma once

#include "local-control.h"
#include <string>
#include <sys/types.h>

namespace koed {
struct ControlListener {
  ControlListener() = default;
  ControlListener(const ControlListener &) = delete;
  ControlListener &operator=(const ControlListener &) = delete;
  int fd = -1;
  std::string path;
  dev_t device = 0;
  ino_t inode = 0;
};

// The caller must validate a private, user-owned parent directory before bind.
// Path cleanup assumes cooperating same-UID processes; same-user hostile
// pathname replacement is outside the executable-signature trust boundary.
bool openControlListener(const std::string &path, ControlListener *listener);
void closeControlListener(ControlListener *listener);
// Returns a nonblocking descriptor, or -1 with errno. The caller must verify
// the server peer before sending application data.
int connectControlSocket(const std::string &path);
// Call after connect completion and before any application data is sent.
// The caller must close the descriptor immediately on failure.
bool authenticateConnectedControlSocket(int fd, SecRequirementRef requirement, ControlPeer *peer);
// The requirement is trusted build policy, never data from the peer.
int acceptControlSocket(int listener, SecRequirementRef requirement, ControlPeer *peer);
}
