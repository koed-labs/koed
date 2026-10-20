# Pixelkin character renderer provenance

The HQ Agent avatar uses the procedural character specification, seeded generation, signed-distance body forms, palette, and separate face painter from [Pixelkin Lab](https://github.com/koed-labs/pixelkin-lab) at commit `8007c81e9f0036a2934a598e80572da7c3f966ef`. `apps/desktop/src/renderer/hq/agents/pixelkin-core.js` preserves that commit's `pixelkin-core.js` logic with repository formatting applied. `pixelkin-renderer.ts` adapts its body and palette mechanics for small offline HQ canvases. The source is MIT licensed:

> MIT License
>
> Copyright (c) 2026 Pixelkin Lab contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

The renderer runs locally without network requests. A persisted Agent `look` can carry a Pixelkin Lab `seed`, `body`, `face`, and `palette` subset, directly or in a `pixelkin` object. When a look is empty, the owner-bound Agent ID supplies a stable seed. Rendering and animation do not alter Agent ownership, model, permissions, or memory.
