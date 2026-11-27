{
  "targets": [
    {
      "target_name": "koed_flock",
      "sources": ["flock.c"],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        ["OS!='linux' and OS!='mac'", { "defines": ["KOED_FLOCK_UNSUPPORTED_PLATFORM"] }]
      ]
    }
  ]
}
