package ops.taskboard;

import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

final class TaskRepository {
    private static final Comparator<Task> TASK_ORDER = Comparator.comparing(Task::updatedAt)
        .reversed()
        .thenComparing(Task::id);

    private final List<Task> tasks = List.of(
        task("OPS-103", "例行权限复核", "周岚", Task.Status.COMPLETED, "2026-09-16T08:50:00Z"),
        task("OPS-108", "例行备份校验", "高宁", Task.Status.PENDING, "2026-09-17T01:20:00Z"),
        task("OPS-105", "重建对账索引", "沈琪", Task.Status.RUNNING, "2026-09-16T10:30:00Z"),
        task("OPS-109", "更新值班联系人", "林嘉", Task.Status.PENDING, "2026-09-17T03:02:00Z"),
        task("OPS-104", "修正发票归档标签", "周岚", Task.Status.COMPLETED, "2026-09-16T09:35:00Z"),
        task("OPS-106", "检查报表链路", "高宁", Task.Status.PENDING, "2026-09-16T11:10:00Z"),
        task("OPS-107", "例行数据库巡检", "林嘉", Task.Status.RUNNING, "2026-09-17T01:20:00Z")
    );

    List<Task> list(String query) {
        String keyword = query.strip().toLowerCase(Locale.ROOT);
        return tasks.stream()
            .filter(task -> matches(task, keyword))
            .sorted(TASK_ORDER)
            .toList();
    }

    private static boolean matches(Task task, String keyword) {
        return task.id().toLowerCase(Locale.ROOT).contains(keyword)
            || task.title().toLowerCase(Locale.ROOT).contains(keyword)
            || task.owner().toLowerCase(Locale.ROOT).contains(keyword);
    }

    private static Task task(String id, String title, String owner, Task.Status status, String updatedAt) {
        return new Task(id, title, owner, status, Instant.parse(updatedAt));
    }
}
