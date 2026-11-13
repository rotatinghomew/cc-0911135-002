GET /manifest 提供 attachments：id、相对 url、size、sha256，以及 allowedHosts。GET /blob 返回二进制，支持 Range: bytes=N- 和 If-Range。version 改变内容及强验证器；weak 改为弱验证器；ignoreRange 返回完整 200；wrongRange 返回不匹配区间；cutOnce 在一段数据后断开连接；corrupt 保持大小但改坏内容。POST /_control 设置这些演练状态。

/redirect 演练同站跳转，external=true 时目的主机不在清单允许列表。接收端应该自行处理跳转而不是自动追随未经核验的目标。

receipt.json 包含 items 数组：id、status（sealed/failed）、path、size、sha256、expectedSha256、validator、source；失败项含 reason。只有 sealed 项指向正式文件，实际文件摘要还需接收命令的测试独立核对。
