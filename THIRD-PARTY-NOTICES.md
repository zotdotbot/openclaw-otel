# Third-party notices

`dist/index.js` is a self-contained bundle: the packages below are inlined into
it at build time (they are `devDependencies`; the published package has zero
runtime dependencies). Their licenses and copyright notices are reproduced or
referenced here as required by their terms. The exact bundled set is derived
from the build's source map.

## Apache License 2.0

Full text: [LICENSE](LICENSE) in this repository, or
<https://www.apache.org/licenses/LICENSE-2.0>.

**Copyright The OpenTelemetry Authors:**

- `@opentelemetry/api`, `@opentelemetry/api-logs`
- `@opentelemetry/context-async-hooks`, `@opentelemetry/core`
- `@opentelemetry/exporter-logs-otlp-grpc`, `@opentelemetry/exporter-logs-otlp-http`
- `@opentelemetry/exporter-metrics-otlp-grpc`, `@opentelemetry/exporter-metrics-otlp-http`
- `@opentelemetry/exporter-trace-otlp-grpc`, `@opentelemetry/exporter-trace-otlp-http`
- `@opentelemetry/otlp-exporter-base`, `@opentelemetry/otlp-grpc-exporter-base`,
  `@opentelemetry/otlp-transformer`
- `@opentelemetry/resources`, `@opentelemetry/sdk-logs`,
  `@opentelemetry/sdk-metrics`, `@opentelemetry/sdk-trace-node`
- `@opentelemetry/semantic-conventions`

**Copyright gRPC authors:**

- `@grpc/grpc-js`, `@grpc/proto-loader`

**Copyright Daniel Wirtz:**

- `long`

## BSD 3-Clause License

**`protobufjs` and `@protobufjs/*`** (`aspromise`, `base64`, `codegen`,
`eventemitter`, `fetch`, `float`, `path`, `pool`, `utf8`) — Copyright (c) 2016,
Daniel Wirtz. All rights reserved.

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of its author, nor the names of its contributors may be
  used to endorse or promote products derived from this software without
  specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## MIT License

- `lodash.camelcase` — Copyright JS Foundation and other contributors
  <https://js.foundation/>
- `@js-sdsl/ordered-map` — Copyright (c) 2021 Zilong Yao

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
