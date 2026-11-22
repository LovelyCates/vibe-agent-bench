# 运维任务看板

运维人员可在任务看板中按任务编号、名称或负责人搜索，查看待处理、进行中和已完成任务。Java 服务提供 HTTP 接口，Vue 页面通过 Vite 代理访问同一个接口。样例使用固定的七条模拟记录，可直接在本机运行。

## 本地运行

使用 Node.js 24、JDK 17 或更新版本。浏览器验收可使用系统安装的 Edge 或 Chrome。没有可用浏览器时，可在安装依赖后运行 `npx playwright install chromium`。

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run dev:api
```

在另一个终端执行 `npm run dev:web`，打开 [任务看板](http://127.0.0.1:5180)。默认 API 地址为 `http://127.0.0.1:8180`。需要改端口时，可传入 `npm run dev:api -- 8181`，并在前端终端设置 `TASK_BOARD_API_URL`。

## 当前行为

- `GET /api/tasks` 返回 `{ items, total }`。每条记录包含 `id`、`title`、`owner`、`status` 和 `updatedAt`。
- 查询参数 `q` 在编号、任务名称和负责人中做大小写不敏感的包含匹配。结果按更新时间降序，同一时刻按编号升序。
- 页面包含可见的关键字搜索、任务表格、加载提示、空态和失败重试。任务行用 `data-task-id` 标识，空态使用 `#empty-state`。
- `openspec/specs/task-board/spec.md` 记录当前行为。

## 待实现需求

在运维任务看板中为列表增加状态筛选。用户可以选择全部状态、待处理、进行中、已完成。列表通过真实 HTTP 请求读取筛选结果，并保留已有关键字搜索和排序。GET /api/tasks 接收可选 status（pending、running、completed），支持与 q 同时使用，非法值或重复 status 返回 400 与 INVALID_STATUS，查无匹配时返回空列表并在页面上显示空态。补充能覆盖新增行为的回归测试。

- 筛选使用可访问名称为「状态」的原生下拉框。选项显示「全部状态」「待处理」「进行中」「已完成」，默认选择全部状态。
- 切换后立即发请求，保留已提交的关键字。选择全部状态时省略 `status`，其余选项发送对应的英文值。
- `status` 只接受三个小写精确值。空字符串、大小写不符、额外空格或重复参数均为无效值。错误体包含 `code: "INVALID_STATUS"` 和可读的 `message`。
- 各条件需要同时匹配。没有匹配记录时返回 `{ "items": [], "total": 0 }`，页面显示空态。

## 验收

原有验收脚本启动真实 Java 和 Vite 服务，可在 `tests/api/` 或 `tests/browser/` 另加测试文件。初始版本的状态筛选断言会失败，已有搜索行为仍可通过验收。

```powershell
npm run lint
npm run build
npm run test:api
npm run test:browser
```

- `lint` 将 Java 编译器警告当作错误，并使用 ESLint 和 Vue 推荐规则检查前端。
- `build` 生成 Vite 构建产物。
- `test:api` 对本地 Java 服务发出真实 HTTP 请求。
- `test:browser` 使用 Chromium 打开 Vue 页面，并检查请求、表格和空态。
