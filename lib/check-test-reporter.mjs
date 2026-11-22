export default async function* reportTests(events) {
  for await (const event of events) {
    if (event.type === "test:pass" || event.type === "test:fail") {
      const { name, file, nesting, skip, todo, details } = event.data;
      const error = details.error;
      yield `${JSON.stringify({
        result: event.type === "test:pass" ? "pass" : "fail",
        name,
        file,
        nesting,
        skip: Boolean(skip),
        todo: Boolean(todo),
        failureType: error?.failureType,
        assertion: error?.code === "ERR_ASSERTION" || error?.cause?.code === "ERR_ASSERTION",
        message: error?.cause?.message ?? error?.message,
      })}\n`;
    }
    if (event.type === "test:stdout" || event.type === "test:stderr") {
      yield `${JSON.stringify({ stream: event.type.split(":")[1], message: event.data.message })}\n`;
    }
  }
}
