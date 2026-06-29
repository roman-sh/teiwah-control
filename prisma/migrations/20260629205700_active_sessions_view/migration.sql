-- Read-only view: non-deleted sessions (Prisma ActiveSession).
CREATE VIEW "active_sessions" AS
SELECT
    "id",
    "userId",
    "phoneNumber",
    "webhookUrl",
    "apiKeyMasked",
    "createdAt",
    "updatedAt"
FROM "sessions"
WHERE "isDeleted" = false;
