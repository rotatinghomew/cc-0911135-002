# supplement-range-receiver

研究附件资源清单与 HTTP 字节区间探针。

## 环境与命令

Node.js 22.23.4，依赖使用 package-lock.json 固定。准备阶段运行 `npm ci`。


```bash
npm run build
npm test
npm run demo
npm start
npm run receive -- http://127.0.0.1:端口 --dir 工作目录
```

`npm start` 输出本次监听地址，另一个终端可运行 `npm run probe -- http://127.0.0.1:端口`。服务只监听本机。`PORT` 可指定端口，Ctrl-C 结束。

`npm run build` 检查所有模块的 JavaScript 语法，无需生成打包文件；`npm test` 检查源端协议、正常及异常响应，并在本地合成站点上逐项演练 `docs/scenarios.md` 的接收情景（断流续传、换版废弃、弱验证器、忽略范围、区间矛盾、416 核对、摘要拒收、异常退出恢复、越域跳转），可重复运行，不访问外网。

## 正式接收

`npm run receive -- <源站地址> [--dir 工作目录] [--concurrency N] [--manifest 清单文件]` 是正式接收命令：拉取 /manifest（或用本地清单），按业务编号逐项接收，默认并行 2，流式写盘，不把附件整体放入内存。只有长度、摘要、业务归属全部通过的条目才原子封存进 `工作目录/sealed/`，并在 `工作目录/receipt.json` 写入回执；任一项失败不影响其他独立附件，但整批 `allSealed` 为 false 且命令退出码为 1，不冒报全成功。

重复运行即续传：只有强 ETag 会用于 If-Range 条件范围请求；弱验证器、200 代替 206、Content-Range 与本地长度不符、416 越界，都会让旧分片作废并记录原因，绝不直接续写。跳转只跟随清单 allowedHosts 内的地址，且跳转前后的验证信息不混用（已有分片作废重收）。

工作目录布局：`var/inbound/` 为分片、`var/ledger/` 为接收账本、`var/quarantine/` 为被隔离的作废分片。账本与封存文件互相核对：回执写入前异常退出，下次运行从账本恢复，已封存文件重新验摘要后直接进入回执，不重复下载；磁盘已有封存文件但账本未提交时，按清单摘要核验后收养或隔离。每次运行结束原子重写 receipt.json，回执逐项记录来源、远端验证器、接收字节、废弃分片原因与拒收缘由。`RECEIVE_CRASH_AFTER_SEAL=1` 是演练钩子，模拟封存后、回执前异常退出，不属于业务路径。

## 数据与运行边界

GET /manifest 提供 attachments：id、相对 url、size、sha256，以及 allowedHosts。GET /blob 返回二进制，支持 Range: bytes=N- 和 If-Range。version 改变内容及强验证器；weak 改为弱验证器；ignoreRange 返回完整 200；wrongRange 返回不匹配区间；cutOnce 在一段数据后断开连接；corrupt 保持大小但改坏内容。POST /_control 设置这些演练状态。

/redirect 演练同站跳转，external=true 时目的主机不在清单允许列表。接收端应该自行处理跳转而不是自动追随未经核验的目标。

receipt.json 包含 items 数组：id、status（sealed/failed）、path、size、sha256、expectedSha256、validator、source；失败项含 reason。只有 sealed 项指向正式文件，实际文件摘要还需接收命令的测试独立核对。

接口的完整字段及演练开关见 `docs/protocol.md`。业务编号均为合成值，不对应真实研究材料；服务没有外网依赖。`/_audit` 查看源端请求证据，`/_control` 只用于运行演练情景，不属于业务采集入口。

现有探针（`npm run probe`）只进行单次协议查看，继续作为排查入口；`npm run receive` 为正式接收命令，仍不提供持久运行调度。原始服务可单独运行，以便采集端在重启时保持源端状态。

## 数据校验

`npm run verify -- receipt.json` 检查本地结果的基本业务不变量，缺少文件时返回非零状态。该命令不生成采集结果，也不替代网络交互和恢复测试。`npm run demo` 在临时本地服务上真实发起请求并完整打印响应，随后退出。日常演练均不需要安装依赖或访问研究站。
