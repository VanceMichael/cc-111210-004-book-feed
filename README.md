# 行情授权源的订单簿重建采集

本项目用于授权资料接入的单次查看与接收留存，并在授权行情源上重建可发布的订单簿，使用 Node.js 22。来源协议见 `docs/source-contract.md`。本地演练服务只绑定回环地址，数据不含真实个人资料或账号。采集只做接收与展示，不做交易或下单。

## 安装与运行

依赖由 `package-lock.json` 固定。首次准备环境运行 `npm ci --ignore-scripts`，浏览器项目使用 Playwright 1.56.1 对应的 Chromium；浏览器及系统库在镜像准备阶段安装，不在业务命令中下载。

```sh
npm run build
npm test
npm run demo
npm run drill
npm start
```

`npm run demo` 启动本地来源和接入服务，实际获取单次查看结果并写入临时接收记录，随后采集一轮订单簿并显示完整 JSON，最后关闭服务并清理临时目录，通常在十秒内结束。`npm run drill` 演练断线、快照与增量交叉、品种下架、同价多条目及接收后未发布就停止的情形，并逐阶段打印三态视图。`npm start` 启动常驻服务，默认端口3000，可通过 PORT 与 DATA_DIR 修改监听端口和接收目录，POLL_MS 修改轮询间隔。设置 SOURCE_URL 可连接另一进程中已启动的本地来源；不设置时自动创建演练来源。恢复演练可先用 `npm run source` 在另一终端启动来源，记下输出地址，保持该进程运行，仅重启设置了 SOURCE_URL 的接入服务。

## 接口与模块

`GET /health` 查看状态，`GET /inspect` 查看来源，`GET /receive?key=sample` 保存单次接收，`GET /receipts/sample` 读取回执。相同key和相同内容可重复接收，不同内容拒绝覆盖。

订单簿接口：

- `GET /book` 查看全部品种，`GET /book?symbol=ORE` 查看单个品种。每个品种标注三种状态之一：`连贯报价`（coherent，可发布，含买卖档位）、`等待重建`（rebuilding，不发布档位）、`已失效`（invalid，品种下架）。档位按价格聚合，保留条目ID与数量，可追溯到来源条目；`basis` 给出订单簿依据的连接与覆盖序号，`history` 解释每次失效与恢复所依据的序号。
- `GET /collect` 手动拉取一批增量并落盘，`GET /rebuild` 对等待重建的品种尝试一次快照恢复。常驻模式下这两步按 POLL_MS 自动交替执行。

## 连贯性规则

- 序号按连接各自连续；同一连接一旦出现缺号，该连接上所有连贯品种一起失效，因为缺掉的消息可能改动任何品种。
- 缺号不靠排序后重放弥补：迟到的序号只记录不补放，恢复只能依靠声明覆盖序号的快照。快照到达期间收到的增量缓存在连接缓冲里，快照之后按序号逐条追平，遇到缺口即停，缓冲有上限（bufferLimit），被淘汰的序号视为永久缺口。
- 旧连接纪元的迟到消息直接丢弃；新纪元的增量不能套在旧连接基点上，触及即触发该品种重建。
- 断线时连贯品种转入等待重建，不再把旧档位当最新报价；来源恢复后全量重订阅，序号规则负责去重。
- 重建状态与接收进度（轮询偏移、各连接序号、缓冲、历史）保存在 DATA_DIR 的 `book-state.json`，原子写入并带摘要校验；进程停止后重启从落盘状态继续，接收后未发布的进度不丢失。

## 模块

`src/book.mjs` 是只做状态机的订单簿引擎，`src/collector.mjs` 负责轮询与重订阅，`src/connector.mjs` 解释单次来源响应，`fixtures/source.mjs` 提供可重复启动的本地来源，`src/service.mjs` 组织访问入口，`src/store.mjs` 保存查看结果与采集状态，`src/decimal.mjs` 处理十进制字符串。`test/book.test.mjs` 验证引擎规则，`test/collector.test.mjs` 验证采集流程与服务边界，`test/connector.test.mjs` 验证协议原语和演练源，`test/service.test.mjs` 验证服务与留存边界。

生产接入地址与凭据需由部署配置给出；演练客户端拒绝访问回环以外的地址。文档中的接口不向外提供任意目标代理。异常以明确错误响应返回，接收失败不覆盖原回执。
