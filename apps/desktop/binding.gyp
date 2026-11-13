{
  "variables": {
    "koed_signing_team_id%": "<!(node -e \"process.stdout.write(process.env.DESKTOP_MACOS_APPLE_TEAM_ID || '')\")"
  },
  "targets": [
    {
      "target_name": "koed_background_xpc",
      "sources": ["src/background-agent/native/xpc.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include_dir\")"
      ],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        [
          "koed_signing_team_id != ''",
          { "defines": ["KOED_SIGNING_TEAM_ID=<(koed_signing_team_id)"] }
        ]
      ],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "OTHER_LDFLAGS": ["-framework Foundation"]
      }
    }
  ]
}
