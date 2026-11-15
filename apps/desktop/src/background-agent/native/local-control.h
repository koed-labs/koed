#pragma once

#include <Security/Security.h>
#include <sys/types.h>

namespace koed {
struct ControlPeer {
  pid_t pid;
  uid_t uid;
};

// Internal primitive; never pass a requirement derived from peer input.
bool verifyControlPeer(int fd, SecRequirementRef requirement, ControlPeer *peer);
// Production policy is pinned to the build's signing team and app identifier.
// The caller owns the returned requirement and must CFRelease it.
SecRequirementRef createProductionControlPeerRequirement();
bool verifyProductionControlPeer(int fd, ControlPeer *peer);
}
