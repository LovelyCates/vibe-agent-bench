package ops.taskboard;

import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

final class TaskController {
    private final TaskRepository tasks;

    TaskController(TaskRepository tasks) {
        this.tasks = tasks;
    }

    void list(HttpExchange exchange) throws IOException {
        try (exchange) {
            if (!"/api/tasks".equals(exchange.getRequestURI().getPath())) {
                send(exchange, 404, error("NOT_FOUND", "资源不存在。"));
                return;
            }
            if (!"GET".equals(exchange.getRequestMethod())) {
                exchange.getResponseHeaders().set("Allow", "GET");
                send(exchange, 405, error("METHOD_NOT_ALLOWED", "只支持 GET。"));
                return;
            }

            String query;
            try {
                query = queryValues(exchange, "q").stream().findFirst().orElse("");
            } catch (IllegalArgumentException invalidEncoding) {
                send(exchange, 400, error("INVALID_QUERY", "无法解析查询参数。"));
                return;
            }

            List<Task> items = tasks.list(query);
            String body = items.stream().map(TaskController::taskJson).collect(Collectors.joining(","));
            send(exchange, 200, "{\"items\":[%s],\"total\":%d}".formatted(body, items.size()));
        }
    }

    void notFound(HttpExchange exchange) throws IOException {
        try (exchange) {
            send(exchange, 404, error("NOT_FOUND", "资源不存在。"));
        }
    }

    private static List<String> queryValues(HttpExchange exchange, String name) {
        String query = exchange.getRequestURI().getRawQuery();
        List<String> values = new ArrayList<>();
        if (query == null) {
            return values;
        }
        for (String part : query.split("&")) {
            String[] parameter = part.split("=", 2);
            if (name.equals(URLDecoder.decode(parameter[0], StandardCharsets.UTF_8))) {
                values.add(parameter.length == 1 ? "" : URLDecoder.decode(parameter[1], StandardCharsets.UTF_8));
            }
        }
        return values;
    }

    private static String taskJson(Task task) {
        return "{\"id\":%s,\"title\":%s,\"owner\":%s,\"status\":%s,\"updatedAt\":%s}".formatted(
            quote(task.id()), quote(task.title()), quote(task.owner()), quote(task.status().value()),
            quote(task.updatedAt().toString()));
    }

    private static String error(String code, String message) {
        return "{\"code\":%s,\"message\":%s}".formatted(quote(code), quote(message));
    }

    private static String quote(String value) {
        StringBuilder json = new StringBuilder("\"");
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character == '"' || character == '\\') {
                json.append('\\').append(character);
            } else if (character < 0x20) {
                json.append(String.format("\\u%04x", (int) character));
            } else {
                json.append(character);
            }
        }
        return json.append('"').toString();
    }

    private static void send(HttpExchange exchange, int status, String body) throws IOException {
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, payload.length);
        exchange.getResponseBody().write(payload);
    }
}
