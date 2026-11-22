package ops.taskboard;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class TaskBoardServer {
    private TaskBoardServer() {}

    public static void main(String[] args) throws IOException {
        int port = args.length == 0 ? 8180 : Integer.parseInt(args[0]);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        ExecutorService workers = Executors.newFixedThreadPool(4);
        TaskController controller = new TaskController(new TaskRepository());
        server.createContext("/api/tasks", controller::list);
        server.createContext("/", controller::notFound);
        server.setExecutor(workers);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.stop(0);
            workers.shutdownNow();
        }));

        server.start();
        System.out.println("TASK_BOARD_READY http://127.0.0.1:" + server.getAddress().getPort());
    }
}
