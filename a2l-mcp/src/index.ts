#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { assignmentTools } from "./tools/dropbox.js";
import { contentTools } from "./tools/content.js";
import { gradeTools } from "./tools/grades.js";
import { calendarTools } from "./tools/calendar.js";
import { newsTools } from "./tools/news.js";
import { enrollmentTools } from "./tools/enrollments.js";
import { downloadFile, readFile, deleteFile } from "./tools/files.js";
import { piazzaTools } from "./tools/piazza.js";
import { PlanningTools } from "./study/src/planning.js";
import { NotesTools } from "./study/src/notes.js";
import { SyncTools } from "./study/src/sync.js";
import { PiazzaTools } from "./study/src/piazza.js";

function createServer(): McpServer {
  console.error("[INIT] createServer() called - starting MCP server initialization");
  
  const server = new McpServer({
    name: "study-mcp",
    version: "1.0.0",
  });

  // Helper to wrap tool handlers with logging
  const wrapToolHandler = (
    toolName: string,
    handler: (args: any) => Promise<string>
  ) => {
    return async (args: any) => {
      const startTime = Date.now();
      console.error(`[TOOL] Starting tool execution: ${toolName}`);
      console.error(`[TOOL] Tool: ${toolName}, Args:`, JSON.stringify(args));
      try {
        const result = await handler(args);
        const elapsedTime = Date.now() - startTime;
        console.error(
          `[TOOL] Completed tool execution: ${toolName} (${elapsedTime}ms)`
        );
        return { content: [{ type: "text" as const, text: result }] };
      } catch (error) {
        const elapsedTime = Date.now() - startTime;
        console.error(
          `[TOOL] Tool execution failed: ${toolName} (${elapsedTime}ms)`,
          error
        );
        throw error;
      }
    };
  };

  // Register assignment tools
  server.tool(
    "get_assignments",
    assignmentTools.get_assignments.description,
    { orgUnitId: assignmentTools.get_assignments.schema.orgUnitId },
    wrapToolHandler("get_assignments", async (args) => {
      return await assignmentTools.get_assignments.handler(
        args as { orgUnitId?: number }
      );
    })
  );

  server.tool(
    "get_assignment",
    assignmentTools.get_assignment.description,
    {
      orgUnitId: assignmentTools.get_assignment.schema.orgUnitId,
      assignmentId: assignmentTools.get_assignment.schema.assignmentId,
    },
    wrapToolHandler("get_assignment", async (args) => {
      return await assignmentTools.get_assignment.handler(
        args as { orgUnitId?: number; assignmentId: number }
      );
    })
  );

  server.tool(
    "get_assignment_submissions",
    assignmentTools.get_assignment_submissions.description,
    {
      orgUnitId: assignmentTools.get_assignment_submissions.schema.orgUnitId,
      assignmentId:
        assignmentTools.get_assignment_submissions.schema.assignmentId,
    },
    wrapToolHandler("get_assignment_submissions", async (args) => {
      return await assignmentTools.get_assignment_submissions.handler(
        args as { orgUnitId?: number; assignmentId: number }
      );
    })
  );

  // Register content tools
  server.tool(
    "get_course_content",
    contentTools.get_course_content.description,
    { orgUnitId: contentTools.get_course_content.schema.orgUnitId },
    wrapToolHandler("get_course_content", async (args) => {
      return await contentTools.get_course_content.handler(
        args as { orgUnitId?: number }
      );
    })
  );

  server.tool(
    "get_course_topic",
    contentTools.get_course_topic.description,
    {
      orgUnitId: contentTools.get_course_topic.schema.orgUnitId,
      topicId: contentTools.get_course_topic.schema.topicId,
    },
    wrapToolHandler("get_course_topic", async (args) => {
      return await contentTools.get_course_topic.handler(
        args as { orgUnitId?: number; topicId: number }
      );
    })
  );

  server.tool(
    "get_course_modules",
    contentTools.get_course_modules.description,
    { orgUnitId: contentTools.get_course_modules.schema.orgUnitId },
    wrapToolHandler("get_course_modules", async (args) => {
      return await contentTools.get_course_modules.handler(
        args as { orgUnitId?: number }
      );
    })
  );

  server.tool(
    "get_course_module",
    contentTools.get_course_module.description,
    {
      orgUnitId: contentTools.get_course_module.schema.orgUnitId,
      moduleId: contentTools.get_course_module.schema.moduleId,
    },
    wrapToolHandler("get_course_module", async (args) => {
      return await contentTools.get_course_module.handler(
        args as { orgUnitId?: number; moduleId: number }
      );
    })
  );

  // Register grade tools
  server.tool(
    "get_my_grades",
    gradeTools.get_my_grades.description,
    { orgUnitId: gradeTools.get_my_grades.schema.orgUnitId },
    wrapToolHandler("get_my_grades", async (args) => {
      return await gradeTools.get_my_grades.handler(
        args as { orgUnitId?: number }
      );
    })
  );

  // Register calendar tools
  server.tool(
    "get_upcoming_due_dates",
    calendarTools.get_upcoming_due_dates.description,
    {
      orgUnitId: calendarTools.get_upcoming_due_dates.schema.orgUnitId,
      daysBack: calendarTools.get_upcoming_due_dates.schema.daysBack,
      daysAhead: calendarTools.get_upcoming_due_dates.schema.daysAhead,
    },
    wrapToolHandler("get_upcoming_due_dates", async (args) => {
      return await calendarTools.get_upcoming_due_dates.handler(
        args as { orgUnitId?: number; daysBack?: number; daysAhead?: number }
      );
    })
  );

  // Register news tools
  server.tool(
    "get_announcements",
    newsTools.get_announcements.description,
    { orgUnitId: newsTools.get_announcements.schema.orgUnitId },
    wrapToolHandler("get_announcements", async (args) => {
      return await newsTools.get_announcements.handler(
        args as { orgUnitId?: number }
      );
    })
  );

  // Register enrollment tools
  server.tool(
    "get_my_courses",
    enrollmentTools.get_my_courses.description,
    {},
    wrapToolHandler("get_my_courses", async () => {
      return await enrollmentTools.get_my_courses.handler();
    })
  );

  // Register file tools
  server.tool(
    "download_file",
    "Get a file from Avenue (D2L Brightspace) and return its text. Provide the file's URL from get_course_content / get_course_topic (e.g. /content/enforced/781481-SFWRENG_3O03_.../hw1.pdf). Files are saved once into the user's course folder, organized by Avenue module (e.g. 'Year 3/Linear Optimization/Avenue/Lecture slides/2_modeling.pdf'), and served from disk afterwards, so calling this again for the same file is instant and doesn't re-download. Returns the local path, status (downloaded / cached / updated), and the extracted text. Set refresh=true only if the user says the file was updated.",
    {
      url: z
        .string()
        .describe(
          "The Avenue URL or path of the file (e.g. /content/enforced/781481-SFWRENG_3O03_deza_1_2269/hw1_3-4O03_26.pdf)"
        ),
      refresh: z
        .boolean()
        .optional()
        .describe("Force a check for a newer version on Avenue"),
      savePath: z
        .string()
        .optional()
        .describe(
          "Optional: also copy the file to this directory or path. Only use if the user asks for a specific location."
        ),
    },
    wrapToolHandler("download_file", async (args) => {
      const result = await downloadFile(args.url, args.savePath, args.refresh);
      const sizeKB = (result.size / 1024).toFixed(1);
      let text = `File: ${result.filename}\nPath: ${result.path}\nStatus: ${result.status}\nSize: ${sizeKB} KB\nType: ${result.contentType}`;
      if (result.note) {
        text += `\nNote: ${result.note}`;
      }

      if (result.content) {
        text += `\n\n--- File Content ---\n${result.content}`;
      }

      return text;
    })
  );

  server.tool(
    "read_file",
    "Read a file from disk and extract its text content. Supports PDF, DOCX, TXT, MD, and other text-based formats. If you provide just a filename, it will search in the Downloads folder. You can also provide a full path. Use this to read files that were previously downloaded from D2L or any other files on your system.",
    {
      filePath: z
        .string()
        .describe(
          "The file path or filename to read. Can be a full path (e.g., /Users/username/Downloads/file.pdf) or just a filename (e.g., file.pdf) which will be searched in Downloads folder."
        ),
    },
    wrapToolHandler("read_file", async (args) => {
      const result = await readFile(args.filePath);
      const sizeKB = (result.size / 1024).toFixed(1);
      let text = `File: ${result.filename}\nPath: ${result.path}\nSize: ${sizeKB} KB\nType: ${result.contentType}`;

      if (result.content) {
        text += `\n\n--- File Content ---\n${result.content}`;
      } else {
        text += `\n\nNote: Could not extract text content from this file type. The file may be binary or unsupported.`;
      }

      return text;
    })
  );

  server.tool(
    "delete_file",
    "Delete a file from disk. Uses the same path resolution as read_file: you can pass a full path or just a filename (it will search your Downloads folder). Use this to clean up downloaded files after you are done reading them.",
    {
      filePath: z
        .string()
        .describe(
          "The file path or filename to delete. Can be a full path (e.g., /Users/username/Downloads/file.pdf) or just a filename (e.g., file.pdf) which will be searched in the Downloads folder."
        ),
    },
    wrapToolHandler("delete_file", async (args) => {
      const result = await deleteFile(args.filePath);
      return `Deleted file: ${result.filename}\nPath: ${result.path}`;
    })
  );

  // Register Piazza tools
  piazzaTools.forEach((tool) => {
    const schema = tool.inputSchema as z.ZodObject<any>;
    server.tool(
      tool.name,
      tool.description,
      schema.shape,
      wrapToolHandler(tool.name, tool.handler)
    );
  });

  // Register Planning tools
  server.tool(
    "tasks_list",
    PlanningTools.tasks_list.description,
    PlanningTools.tasks_list.schema,
    wrapToolHandler("tasks_list", PlanningTools.tasks_list.handler)
  );

  server.tool(
    "tasks_complete",
    PlanningTools.tasks_complete.description,
    PlanningTools.tasks_complete.schema,
    wrapToolHandler("tasks_complete", PlanningTools.tasks_complete.handler)
  );

  server.tool(
    "notes_sync",
    NotesTools.notes_sync.description,
    NotesTools.notes_sync.schema,
    wrapToolHandler("notes_sync", NotesTools.notes_sync.handler)
  );

  server.tool(
    "notes_search",
    NotesTools.notes_search.description,
    NotesTools.notes_search.schema,
    wrapToolHandler("notes_search", NotesTools.notes_search.handler)
  );

  server.tool(
    "notes_suggest_for_item",
    NotesTools.notes_suggest_for_item.description,
    NotesTools.notes_suggest_for_item.schema,
    wrapToolHandler("notes_suggest_for_item", NotesTools.notes_suggest_for_item.handler)
  );

  server.tool(
    "notes_embed_missing",
    NotesTools.notes_embed_missing.description,
    NotesTools.notes_embed_missing.schema,
    wrapToolHandler("notes_embed_missing", NotesTools.notes_embed_missing.handler)
  );

  server.tool(
    "sync_all",
    SyncTools.sync_all.description,
    SyncTools.sync_all.schema,
    wrapToolHandler("sync_all", SyncTools.sync_all.handler)
  );

  server.tool(
    "plan_week",
    PlanningTools.plan_week.description,
    PlanningTools.plan_week.schema,
    wrapToolHandler("plan_week", PlanningTools.plan_week.handler)
  )

  server.tool(
    "tasks_add",
    PlanningTools.tasks_add.description,
    PlanningTools.tasks_add.schema,
    wrapToolHandler("task_add", PlanningTools.tasks_add.handler)
  );

  // Register Piazza study tools
  server.tool(
    "piazza_sync",
    PiazzaTools.piazza_sync.description,
    PiazzaTools.piazza_sync.schema,
    wrapToolHandler("piazza_sync", PiazzaTools.piazza_sync.handler)
  );

  server.tool(
    "piazza_embed_missing",
    PiazzaTools.piazza_embed_missing.description,
    PiazzaTools.piazza_embed_missing.schema,
    wrapToolHandler("piazza_embed_missing", PiazzaTools.piazza_embed_missing.handler)
  );

  server.tool(
    "piazza_semantic_search",
    PiazzaTools.piazza_semantic_search.description,
    PiazzaTools.piazza_semantic_search.schema,
    wrapToolHandler("piazza_semantic_search", PiazzaTools.piazza_semantic_search.handler)
  );

  server.tool(
    "piazza_suggest_for_item",
    PiazzaTools.piazza_suggest_for_item.description,
    PiazzaTools.piazza_suggest_for_item.schema,
    wrapToolHandler("piazza_suggest_for_item", PiazzaTools.piazza_suggest_for_item.handler)
  );

  return server;
}

async function main() {
  const transportType = process.env.MCP_TRANSPORT?.toLowerCase() || "http";

  if (transportType === "stdio") {
    // Use stdio transport (manual selection)
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("D2L Brightspace MCP server running on stdio");
  } else if (transportType === "http" || transportType === "https") {
    // Use HTTP transport with StreamableHTTPServerTransport
    const port = process.env.MCP_PORT
      ? parseInt(process.env.MCP_PORT, 10)
      : 3000;
    const app = express();

    app.use(express.json());
    app.use(
      cors({
        origin: "*",
        exposedHeaders: ["Mcp-Session-Id"],
      })
    );

    // Ensure Accept header includes both types required by MCP SDK
    app.use("/mcp", (req, _res, next) => {
      const accept = req.headers["accept"] || "";
      if (!accept.includes("text/event-stream")) {
        req.headers["accept"] = accept
          ? `${accept}, text/event-stream`
          : "application/json, text/event-stream";
      }
      next();
    });

    // Map to store transports by session ID
    const transports: Record<string, StreamableHTTPServerTransport> = {};
    
    // Session persistence
    const SESSION_FILE = path.join(process.cwd(), '.mcp-sessions.json');
    const validSessionIds = new Set<string>();
    
    // Load persisted sessions on startup
    async function loadSessions() {
      try {
        const data = await fs.readFile(SESSION_FILE, 'utf-8');
        const sessions = JSON.parse(data);
        sessions.forEach((id: string) => validSessionIds.add(id));
        console.error(`[SESSION] Loaded ${validSessionIds.size} persisted session(s)`);
      } catch {
        console.error('[SESSION] No existing sessions file found, starting fresh');
      }
    }
    
    // Save sessions to disk
    async function saveSessions() {
      try {
        const sessions = Array.from(validSessionIds);
        await fs.writeFile(SESSION_FILE, JSON.stringify(sessions, null, 2));
        console.error(`[SESSION] Saved ${sessions.length} session(s) to disk`);
      } catch (error) {
        console.error('[SESSION] Failed to save sessions:', error);
      }
    }
    
    // Load sessions on startup
    await loadSessions();

    // MCP POST endpoint
    const mcpPostHandler = async (
      req: express.Request,
      res: express.Response
    ) => {
      // Bearer token auth (only if token is set)
      const token = process.env.STUDY_MCP_TOKEN;
      const authHeader = req.headers["authorization"] || req.headers["Authorization"];
      if (token && (!authHeader || authHeader !== `Bearer ${token}`)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const requestStartTime = Date.now();
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const requestMethod = req.body?.method || "unknown";
      const requestId = req.body?.id || null;
      const requestParams = req.body?.params || {};

      console.error(`[MCP] POST request received`);
      console.error(
        `[MCP] Session ID: ${sessionId || "none (initialization)"}`
      );
      console.error(`[MCP] Method: ${requestMethod}`);
      console.error(`[MCP] Request ID: ${requestId}`);
      console.error(`[MCP] Active sessions: ${Object.keys(transports).join(', ') || 'none'}`);
      console.error(`[MCP] Headers:`, JSON.stringify(req.headers, null, 2));
      if (requestMethod === "tools/call") {
        console.error(
          `[MCP] Tool: ${requestParams.name || "unknown"}, Args:`,
          JSON.stringify(requestParams.arguments || {})
        );
      }

      try {
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
          // Reuse existing transport
          console.error(
            `[MCP] Reusing existing transport for session: ${sessionId}`
          );
          transport = transports[sessionId];
        } else if (sessionId && validSessionIds.has(sessionId)) {
          // Session exists but transport is gone (server restart)
          // Silently restore the session regardless of request type
          console.error(
            `[MCP] Silently restoring session ${sessionId} after server restart`
          );
          
          const initStartTime = Date.now();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => sessionId, // Reuse the persisted session ID
            onsessioninitialized: (sid: string) => {
              const initTime = Date.now() - initStartTime;
              console.error(`[MCP] Session silently restored: ${sid} (${initTime}ms)`);
              // Don't wait - already setting transports[sid] below
            },
            onsessionclosed: (sid: string) => {
              console.error(`[MCP] Session closed: ${sid}`);
              delete transports[sid];
              validSessionIds.delete(sid);
              void saveSessions();
            },
          });
          
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports[sid]) {
              console.error(`[MCP] Transport closed for session ${sid}`);
              delete transports[sid];
            }
          };
          
          // Connect server to transport
          const server = createServer();
          await server.connect(transport);
          
          // IMPORTANT: Manually set the sessionId and mark as initialized
          // This bypasses the normal initialize handshake
          (transport as any).sessionId = sessionId;
          (transport as any)._initialized = true;
          
          // Store transport immediately
          transports[sessionId] = transport;
          
          // Now handle the actual request through the restored transport
          await transport.handleRequest(req, res, req.body);
          const totalTime = Date.now() - requestStartTime;
          console.error(`[MCP] Session restored and request handled (${totalTime}ms)`);
          return;
        } else if (!sessionId && isInitializeRequest(req.body)) {
          // New initialization request
          const initStartTime = Date.now();
          console.error(`[MCP] Creating new transport for initialization`);
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId: string) => {
              const initTime = Date.now() - initStartTime;
              console.error(
                `[MCP] Session initialized with ID: ${sessionId} (${initTime}ms)`
              );
              transports[sessionId] = transport;
              validSessionIds.add(sessionId);
              void saveSessions();
            },
            onsessionclosed: (sessionId: string) => {
              console.error(`[MCP] Session closed: ${sessionId}`);
              delete transports[sessionId];
              validSessionIds.delete(sessionId);
              void saveSessions();
            },
          });

          // Set up onclose handler to clean up transport when closed
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports[sid]) {
              console.error(
                `[MCP] Transport closed for session ${sid}, removing from transports map`
              );
              delete transports[sid];
            }
          };

          // Connect the transport to the MCP server BEFORE handling the request
          const server = createServer();
          const connectStartTime = Date.now();
          await server.connect(transport);
          const connectTime = Date.now() - connectStartTime;
          console.error(
            `[MCP] Server connected to transport (${connectTime}ms)`
          );

          const handleStartTime = Date.now();
          await transport.handleRequest(req, res, req.body);
          const handleTime = Date.now() - handleStartTime;
          const totalTime = Date.now() - requestStartTime;
          console.error(
            `[MCP] Request handled (${handleTime}ms, total: ${totalTime}ms)`
          );
          return; // Already handled
        } else {
          // Invalid request - no session ID or not initialization request
          const totalTime = Date.now() - requestStartTime;
          console.error(
            `[MCP] Invalid request - no session ID or not initialization (${totalTime}ms)`
          );
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: No valid session ID provided",
            },
            id: null,
          });
          return;
        }

        // Handle the request with existing transport
        const handleStartTime = Date.now();
        await transport.handleRequest(req, res, req.body);
        const handleTime = Date.now() - handleStartTime;
        const totalTime = Date.now() - requestStartTime;
        console.error(
          `[MCP] Request handled (${handleTime}ms, total: ${totalTime}ms)`
        );
      } catch (error) {
        const totalTime = Date.now() - requestStartTime;
        console.error(
          `[MCP] Error handling MCP request (${totalTime}ms):`,
          error
        );
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          });
        }
      }
    };

    app.post("/mcp", mcpPostHandler);

    // Handle GET requests for SSE streams
    const mcpGetHandler = async (
      req: express.Request,
      res: express.Response
    ) => {
      // Bearer token auth (only if token is set)
      const token = process.env.STUDY_MCP_TOKEN;
      const authHeader = req.headers["authorization"] || req.headers["Authorization"];
      if (token && (!authHeader || authHeader !== `Bearer ${token}`)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const requestStartTime = Date.now();
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      console.error(`[MCP] GET request received`);
      console.error(`[MCP] Session ID: ${sessionId || "none"}`);

      if (!sessionId || !transports[sessionId]) {
        const totalTime = Date.now() - requestStartTime;
        console.error(`[MCP] Invalid or missing session ID (${totalTime}ms)`);
        res.status(400).send("Invalid or missing session ID");
        return;
      }

      const lastEventId = req.headers["last-event-id"] as string | undefined;
      if (lastEventId) {
        console.error(
          `[MCP] Client reconnecting with Last-Event-ID: ${lastEventId}`
        );
      } else {
        console.error(
          `[MCP] Establishing new SSE stream for session ${sessionId}`
        );
      }

      const transport = transports[sessionId];
      const handleStartTime = Date.now();
      await transport.handleRequest(req, res);
      const handleTime = Date.now() - handleStartTime;
      const totalTime = Date.now() - requestStartTime;
      console.error(
        `[MCP] GET request handled (${handleTime}ms, total: ${totalTime}ms)`
      );
    };

    app.get("/mcp", mcpGetHandler);

    // Handle DELETE requests for session termination
    const mcpDeleteHandler = async (
      req: express.Request,
      res: express.Response
    ) => {
      // Bearer token auth (only if token is set)
      const token = process.env.STUDY_MCP_TOKEN;
      const authHeader = req.headers["authorization"] || req.headers["Authorization"];
      if (token && (!authHeader || authHeader !== `Bearer ${token}`)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const requestStartTime = Date.now();
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      console.error(`[MCP] DELETE request received`);
      console.error(`[MCP] Session ID: ${sessionId || "none"}`);

      if (!sessionId || !transports[sessionId]) {
        const totalTime = Date.now() - requestStartTime;
        console.error(`[MCP] Invalid or missing session ID (${totalTime}ms)`);
        res.status(400).send("Invalid or missing session ID");
        return;
      }

      console.error(
        `[MCP] Received session termination request for session ${sessionId}`
      );
      try {
        const transport = transports[sessionId];
        const handleStartTime = Date.now();
        await transport.handleRequest(req, res);
        const handleTime = Date.now() - handleStartTime;
        const totalTime = Date.now() - requestStartTime;
        console.error(
          `[MCP] DELETE request handled (${handleTime}ms, total: ${totalTime}ms)`
        );
      } catch (error) {
        const totalTime = Date.now() - requestStartTime;
        console.error(
          `[MCP] Error handling session termination (${totalTime}ms):`,
          error
        );
        if (!res.headersSent) {
          res.status(500).send("Error processing session termination");
        }
      }
    };

    app.delete("/mcp", mcpDeleteHandler);

    app.listen(port, () => {
      console.error(`D2L Brightspace MCP server running on HTTP port ${port}`);
      console.error(`Connect to: http://localhost:${port}/mcp`);
    });

    // Handle server shutdown
    process.on("SIGINT", async () => {
      console.error("Shutting down server...");
      // Close all active transports to properly clean up resources
      for (const sessionId in transports) {
        try {
          console.error(`Closing transport for session ${sessionId}`);
          await transports[sessionId].close();
          delete transports[sessionId];
        } catch (error) {
          console.error(
            `Error closing transport for session ${sessionId}:`,
            error
          );
        }
      }
      console.error("Server shutdown complete");
      process.exit(0);
    });
  } else {
    console.error(
      `Invalid MCP_TRANSPORT value: ${transportType}. Must be 'stdio', 'http', or 'https'`
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
