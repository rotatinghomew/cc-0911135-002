# supplement-range-receiver

研究附件资源清单与 HTTP 字节区间探针。

## 环境与命令

Node.js 22.23.4，依赖使用 package-lock.json 固定。准备阶段运行 `npm ci`。


```bash
npm run build
npm test
npm run demo
npm start
```

`npm start` 输出本次监听地址，另一个终端可运行 `npm run probe -- http://127.0.0.1:端口`。服务只监听本机。`PORT` 可指定端口，Ctrl-C 结束。

`npm run build` 检查所有模块的 JavaScript 语法，无需生成打包文件；`npm test` 检查源端协议、正常及异常响应。

## 数据与运行边界

GET /manifest 提供 attachments：id、相对 url、size、sha256，以及 allowedHosts。GET /blob 返回二进制，支持 Range: bytes=N- 和 If-Range。version 改变内容及强验证器；weak 改为弱验证器；ignoreRange 返回完整 200；wrongRange 返回不匹配区间；cutOnce 在一段数据后断开连接；corrupt 保持大小但改坏内容。POST /_control 设置这些演练状态。

/redirect 演练同站跳转，external=true 时目的主机不在清单允许列表。接收端应该自行处理跳转而不是自动追随未经核验的目标。

receipt.json 包含 items 数组：id、status（sealed/failed）、path、size、sha256、expectedSha256、validator、source；失败项含 reason。只有 sealed 项指向正式文件，实际文件摘要还需接收命令的测试独立核对。

接口的完整字段及演练开关见 `docs/protocol.md`。业务编号均为合成值，不对应真实研究材料；服务没有外网依赖。`/_audit` 查看源端请求证据，`/_control` 只用于运行演练情景，不属于业务采集入口。

现有客户端只进行单次协议查看；尚不提供自动采集与持久运行调度。原始服务可单独运行，以便采集端在重启时保持源端状态。

## 数据校验

`npm run verify -- receipt.json` 检查本地结果的基本业务不变量，缺少文件时返回非零状态。该命令不生成采集结果，也不替代网络交互和恢复测试。`npm run demo` 在临时本地服务上真实发起请求并完整打印响应，随后退出。日常演练均不需要安装依赖或访问研究站。
