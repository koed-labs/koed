#import <Foundation/Foundation.h>
#import <Security/Security.h>

#include "local-control.h"
#include <bsm/libbsm.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <cstring>

#define KOED_CONTROL_STRINGIFY_INNER(value) #value
#define KOED_CONTROL_STRINGIFY(value) KOED_CONTROL_STRINGIFY_INNER(value)
#ifdef KOED_SIGNING_TEAM_ID
#define KOED_CONTROL_TEAM_ID KOED_CONTROL_STRINGIFY(KOED_SIGNING_TEAM_ID)
#else
#define KOED_CONTROL_TEAM_ID ""
#endif

namespace koed {
bool verifyControlPeer(int fd, SecRequirementRef requirement, ControlPeer *peer) {
  if (fd < 0 || !requirement || !peer) return false;
  uid_t uid;
  gid_t gid;
  if (getpeereid(fd, &uid, &gid) != 0 || uid != geteuid()) return false;

  audit_token_t token{};
  socklen_t length = sizeof(token);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) != 0 ||
      length != sizeof(token) || audit_token_to_euid(token) != uid)
    return false;

  @autoreleasepool {
    NSData *tokenData = [NSData dataWithBytes:&token length:sizeof(token)];
    NSDictionary *attributes = @{(__bridge id)kSecGuestAttributeAudit: tokenData};
    SecCodeRef code = nullptr;
    OSStatus status = SecCodeCopyGuestWithAttributes(
        nullptr, (__bridge CFDictionaryRef)attributes, kSecCSDefaultFlags, &code);
    if (status != errSecSuccess || !code) return false;
    status = SecCodeCheckValidity(code, kSecCSDefaultFlags, requirement);
    CFRelease(code);
    if (status != errSecSuccess) return false;
  }
  peer->pid = audit_token_to_pid(token);
  peer->uid = uid;
  return peer->pid > 0;
}

SecRequirementRef createProductionControlPeerRequirement() {
  const char *team = KOED_CONTROL_TEAM_ID;
  if (std::strlen(team) != 10) return nullptr;
  for (const char *p = team; *p; ++p)
    if (!((*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9'))) return nullptr;
  @autoreleasepool {
    NSString *expression = [NSString stringWithFormat:
      @"identifier \"ai.koed.desktop\" and anchor apple generic and "
       "certificate 1[field.1.2.840.113635.100.6.2.6] exists and "
       "certificate leaf[field.1.2.840.113635.100.6.1.13] exists and "
       "certificate leaf[subject.OU] = \"%s\"", team];
    SecRequirementRef requirement = nullptr;
    if (SecRequirementCreateWithString((__bridge CFStringRef)expression, kSecCSDefaultFlags, &requirement) != errSecSuccess) return nullptr;
    return requirement;
  }
}

bool verifyProductionControlPeer(int fd, ControlPeer *peer) {
  SecRequirementRef requirement = createProductionControlPeerRequirement();
  if (!requirement) return false;
  const bool valid = verifyControlPeer(fd, requirement, peer);
  CFRelease(requirement);
  return valid;
}
}
