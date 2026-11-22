package ops.taskboard;

import java.time.Instant;

record Task(String id, String title, String owner, Status status, Instant updatedAt) {
    enum Status {
        PENDING("pending"),
        RUNNING("running"),
        COMPLETED("completed");

        private final String value;

        Status(String value) {
            this.value = value;
        }

        String value() {
            return value;
        }
    }
}
