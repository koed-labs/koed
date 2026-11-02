// Expression presets shared by the renderer, the lab and apps.
// Imported from the website expression catalog; every preset has the same numeric fields.
export const EXPRESSIONS = (() => {
  const parts = {
"eyes": {
  "neutral": {
    "eyeY": 0,
    "eyeCross": 0,
    "joyEyes": 0,
    "leftEyeOpen": 1,
    "rightEyeOpen": 1,
    "eyeSmile": 0,
    "eyeTilt": 0,
    "eyeConcave": 0,
    "blinkEyes": 0,
    "winkBlink": 0
  },
  "happy": {
    "eyeY": 0,
    "eyeCross": 0,
    "joyEyes": 0,
    "leftEyeOpen": 0.88,
    "rightEyeOpen": 0.88,
    "eyeSmile": 0.18,
    "eyeTilt": 0,
    "eyeConcave": 0,
    "blinkEyes": 0,
    "winkBlink": 0
  },
  "celebration": {
    "eyeY": 0,
    "eyeCross": 0,
    "joyEyes": 1,
    "leftEyeOpen": 0.18,
    "rightEyeOpen": 0.18,
    "eyeSmile": 1,
    "eyeTilt": 0,
    "eyeConcave": 0,
    "blinkEyes": 0,
    "winkBlink": 0
  },
  "sad": {
    "eyeY": 0,
    "eyeCross": 0,
    "joyEyes": 0,
    "leftEyeOpen": 0.78,
    "rightEyeOpen": 0.78,
    "eyeSmile": 0,
    "eyeTilt": -0.08,
    "eyeConcave": 0,
    "blinkEyes": 0,
    "winkBlink": 0
  },
  "angry": {
    "eyeY": 0,
    "eyeCross": 0,
    "joyEyes": 0,
    "leftEyeOpen": 0.63,
    "rightEyeOpen": 0.63,
    "eyeSmile": 0,
    "eyeTilt": 0.12,
    "eyeConcave": 0,
    "blinkEyes": 0,
    "winkBlink": 0
  },
  "surprised": {
    "eyeY": 0,
    "eyeCross": 0,
    "joyEyes": 0,
    "leftEyeOpen": 1.34,
    "rightEyeOpen": 1.34,
    "eyeSmile": 0,
    "eyeTilt": 0,
    "eyeConcave": 0,
    "blinkEyes": 0,
    "winkBlink": 0
  },
  "sleepy": {
    "eyeY": 0,
    "eyeCross": 0,
    "joyEyes": 1,
    "leftEyeOpen": 0.18,
    "rightEyeOpen": 0.18,
    "eyeSmile": 1,
    "eyeTilt": 0,
    "eyeConcave": 1,
    "blinkEyes": 0,
    "winkBlink": 0
  },
  "curious": {
    "eyeY": 0,
    "eyeCross": 0,
    "joyEyes": 0,
    "leftEyeOpen": 0.592,
    "rightEyeOpen": 1.12,
    "eyeSmile": 0,
    "eyeTilt": 0.03,
    "eyeConcave": 0,
    "blinkEyes": 0,
    "winkBlink": 0
  },
  "wink": {
    "eyeY": 0,
    "eyeCross": 0,
    "joyEyes": 1,
    "leftEyeOpen": 0.12,
    "rightEyeOpen": 1.02,
    "eyeSmile": 0.75,
    "eyeTilt": 0,
    "eyeConcave": 0,
    "blinkEyes": 0,
    "winkBlink": 1
  },
  "fried": {
    "eyeY": 0,
    "eyeCross": 1,
    "joyEyes": 0,
    "leftEyeOpen": 1,
    "rightEyeOpen": 1,
    "eyeSmile": 0,
    "eyeTilt": 0,
    "eyeConcave": 0,
    "blinkEyes": 0,
    "winkBlink": 0
  },
  "blink": {
    "eyeY": 0,
    "eyeCross": 0,
    "joyEyes": 0,
    "leftEyeOpen": 0.05,
    "rightEyeOpen": 0.05,
    "eyeSmile": 0,
    "eyeTilt": 0,
    "eyeConcave": 0,
    "blinkEyes": 1,
    "winkBlink": 0
  }
},
"brows": {
  "neutral": {
    "browLift": 0.24,
    "browTilt": 0,
    "browAsym": 0,
    "browArch": 0,
    "browSpacing": 1
  },
  "happy": {
    "browLift": 0.36,
    "browTilt": 0.05,
    "browAsym": 0,
    "browArch": 1,
    "browSpacing": 1
  },
  "sad": {
    "browLift": -0.2,
    "browTilt": -1.36,
    "browAsym": 0,
    "browArch": 0,
    "browSpacing": 1
  },
  "angry": {
    "browLift": -0.22,
    "browTilt": 1.84,
    "browAsym": 0,
    "browArch": 0,
    "browSpacing": 0.81
  },
  "sleepy": {
    "browLift": -0.25,
    "browTilt": -0.1,
    "browAsym": 0,
    "browArch": 0,
    "browSpacing": 1
  },
  "curious": {
    "browLift": 0.18,
    "browTilt": 0.1,
    "browAsym": -0.72,
    "browArch": 0,
    "browSpacing": 1
  },
  "wink": {
    "browLift": 0,
    "browTilt": 0.05,
    "browAsym": -0.7854545454545455,
    "browArch": 1,
    "browSpacing": 1
  }
},
"mouth": {
  "neutral": {
    "mouthSmileOpen": 0,
    "mouthCurve": 0.12,
    "mouthOpen": 0,
    "mouthWidth": 0.74,
    "mouthRound": 0,
    "mouthTilt": 0,
    "mouthSpeed": 1,
    "mouthWave": 0
  },
  "happy": {
    "mouthSmileOpen": 0,
    "mouthCurve": 0.92,
    "mouthOpen": 0.18,
    "mouthWidth": 1,
    "mouthRound": 0,
    "mouthTilt": 0,
    "mouthSpeed": 1,
    "mouthWave": 0
  },
  "celebration": {
    "mouthSmileOpen": 0,
    "mouthCurve": 0.62,
    "mouthOpen": 0.9,
    "mouthWidth": 1.04,
    "mouthRound": 0.18,
    "mouthTilt": 0,
    "mouthSpeed": 1,
    "mouthWave": 0
  },
  "joy": {
    "mouthSmileOpen": 1,
    "mouthCurve": 0.62,
    "mouthOpen": 0.9,
    "mouthWidth": 1.04,
    "mouthRound": 0.18,
    "mouthTilt": 0,
    "mouthSpeed": 1,
    "mouthWave": 0
  },
  "sad": {
    "mouthSmileOpen": 0,
    "mouthCurve": -1.29,
    "mouthOpen": 0.08,
    "mouthWidth": 0.72,
    "mouthRound": 0,
    "mouthTilt": 0,
    "mouthSpeed": 1,
    "mouthWave": 0
  },
  "angry": {
    "mouthSmileOpen": 0,
    "mouthCurve": -2.2,
    "mouthOpen": 0.14,
    "mouthWidth": 0.82,
    "mouthRound": 0,
    "mouthTilt": 0,
    "mouthSpeed": 1,
    "mouthWave": 0
  },
  "surprised": {
    "mouthSmileOpen": 0,
    "mouthCurve": 0,
    "mouthOpen": 1.05,
    "mouthWidth": 0.52,
    "mouthRound": 1,
    "mouthTilt": 0,
    "mouthSpeed": 1,
    "mouthWave": 0
  },
  "sleepy": {
    "mouthSmileOpen": 0,
    "mouthCurve": 0.62,
    "mouthOpen": 0.9,
    "mouthWidth": 1.04,
    "mouthRound": 0.18,
    "mouthTilt": 0,
    "mouthSpeed": 0.16666666666666666,
    "mouthWave": 0
  },
  "curious": {
    "mouthSmileOpen": 0,
    "mouthCurve": 0.18,
    "mouthOpen": 0,
    "mouthWidth": 0.62,
    "mouthRound": 0,
    "mouthTilt": 0.18,
    "mouthSpeed": 1,
    "mouthWave": 0
  },
  "fried": {
    "mouthSmileOpen": 0,
    "mouthCurve": -0.2,
    "mouthOpen": 0.3,
    "mouthWidth": 0.58,
    "mouthRound": 0.6,
    "mouthTilt": 0,
    "mouthSpeed": 1,
    "mouthWave": 1
  }
}
};
  const recipes = {
"neutral": {
  "eyes": "neutral",
  "brows": "neutral",
  "mouth": "neutral"
},
"happy": {
  "eyes": "happy",
  "brows": "happy",
  "mouth": "happy"
},
"celebration": {
  "eyes": "celebration",
  "brows": "happy",
  "mouth": "celebration"
},
"joy": {
  "eyes": "celebration",
  "brows": "happy",
  "mouth": "joy"
},
"sad": {
  "eyes": "sad",
  "brows": "sad",
  "mouth": "sad"
},
"angry": {
  "eyes": "angry",
  "brows": "angry",
  "mouth": "angry"
},
"surprised": {
  "eyes": "surprised",
  "brows": "happy",
  "mouth": "surprised"
},
"sleepy": {
  "eyes": "sleepy",
  "brows": "sleepy",
  "mouth": "sleepy"
},
"curious": {
  "eyes": "curious",
  "brows": "curious",
  "mouth": "curious"
},
"wink": {
  "eyes": "wink",
  "brows": "wink",
  "mouth": "happy"
},
"fried": {
  "eyes": "fried",
  "brows": "happy",
  "mouth": "fried"
},
"maleficent": {
  "eyes": "angry",
  "brows": "angry",
  "mouth": "joy"
},
"indignant": {
  "eyes": "blink",
  "brows": "angry",
  "mouth": "angry"
}
};
  return Object.fromEntries(Object.entries(recipes).map(([name, recipe]) => [name, { ...parts.eyes[recipe.eyes], ...parts.brows[recipe.brows], ...parts.mouth[recipe.mouth] }]));
})();
