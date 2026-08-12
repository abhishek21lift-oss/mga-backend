-- 049_agent_tables.sql
-- Tables for the 619 Command AI multi-agent orchestration layer.
-- Every agent invocation and every tool call it makes is recorded here.
-- Note: users.id and ai_conversations.id are TEXT (UUID stored as text),
--       so FK columns must also be TEXT.

-- agent_tasks: one row per CEO Agent invocation (natural-language request).
CREATE TABLE IF NOT EXISTS agent_tasks (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id          VARCHAR(100),
  conversation_id     TEXT        REFERENCES ai_conversations(id) ON DELETE SET NULL,
  input_text          TEXT        NOT NULL,
  parsed_intent       VARCHAR(100),
  parsed_entities     JSONB,
  status              VARCHAR(30) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','planning','awaiting_confirmation','executing','completed','failed','cancelled')),
  plan                JSONB,
  confirmation_token  VARCHAR(100),
  result              JSONB,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_user       ON agent_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status     ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_created_at ON agent_tasks(created_at DESC);

-- agent_audit_log: immutable record of every tool call made by any agent.
CREATE TABLE IF NOT EXISTS agent_audit_log (
  id            BIGSERIAL    PRIMARY KEY,
  task_id       UUID         REFERENCES agent_tasks(id) ON DELETE SET NULL,
  agent_name    VARCHAR(100) NOT NULL,
  tool_name     VARCHAR(100),
  action        VARCHAR(100),
  entity_type   VARCHAR(100),
  entity_id     VARCHAR(100),
  params        JSONB,
  result        JSONB,
  status        VARCHAR(20)  NOT NULL DEFAULT 'success'
                  CHECK (status IN ('success','failed','skipped','pending')),
  error_message TEXT,
  user_id       TEXT         REFERENCES users(id) ON DELETE SET NULL,
  ip_address    INET,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_audit_task       ON agent_audit_log(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_audit_user       ON agent_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_audit_created_at ON agent_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_audit_entity     ON agent_audit_log(entity_type, entity_id);
