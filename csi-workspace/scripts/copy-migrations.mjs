// Cross-platform (Windows/macOS/Linux) copy of SQL migrations into the server build.
import fs from "node:fs";
fs.cpSync("server/db/migrations", "dist-server/server/db/migrations", { recursive: true });
