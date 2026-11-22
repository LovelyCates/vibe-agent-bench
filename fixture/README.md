# 后台任务列表样例

后端从 `backend/server.mjs` 启动，前端从 `frontend/server.mjs` 启动。可以通过 `PORT=0` 让服务选择空闲端口。服务监听在 `127.0.0.1`，启动后第一行输出含 `port` 的 JSON。前端利用 `BACKEND_URL` 将 `/api/tasks` 请求转发至后端。两个进程分别提供 `/health` 健康检查。

本次任务主要修改 `backend/tasks-route.mjs`、`frontend/index.html`、`frontend/app.mjs` 和 `frontend/style.css`。`backend/task-store.mjs` 的 `listTasks(tasks, status)` 接受可选状态并返回按原顺序筛选的任务。请保留启动脚本、数据文件和任务存储模块。添加 `test/**/*.test.mjs` 测试文件，使用 Node 内置测试框架和真实 HTTP 请求。`createBackend()` 返回尚未监听的 Node HTTP 服务，可在测试里令其监听随机端口。

## API 契约

`GET /api/tasks` 返回 `{"tasks":[{"id":"T-104","title":"重新生成每日报表","status":"queued"}]}` 形式的 JSON。默认顺序是 `T-104`（待处理）、`T-103`（进行中）、`T-102`（已完成）、`T-101`（待处理）。

用 `status=queued`、`status=running` 或 `status=completed` 筛选。省略 `status` 时返回全部，非法值（含空值）或重复的 `status` 参数返回 400，错误体包含字符串字段 `error`。第二组数据的任务只有待处理和进行中。筛选已完成时返回 `{"tasks":[]}`。

## 页面契约

页面保留原列表，添加关联可见标签的 `select#status-filter`，选项值是 `""`、`queued`、`running` 和 `completed`。默认值 `""` 表示全部。每行保留 `#task-list` 下的 `data-task-id`，`#empty-state` 在空列表时可见，有任务时隐藏。选择更新时由应用向同源 API 请求数据并渲染返回的任务。切回全部时省略 `status` 参数。
