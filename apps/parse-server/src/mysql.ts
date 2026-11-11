import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'

export interface MysqlConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
  socketPath?: string
}

export function mysqlConfigFromEnv(): MysqlConfig | null {
  const database = process.env.MYSQL_DATABASE
  if (!database) return null
  return {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
    database,
    socketPath: process.env.MYSQL_SOCKET || undefined,
  }
}

/** MySQL persistence for file metadata, sessions and (small) chunk manifests. */
export class MysqlDatabase {
  readonly pool: Pool

  constructor(readonly config: MysqlConfig) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      socketPath: config.socketPath,
      waitForConnections: true,
      connectionLimit: 8,
      charset: 'utf8mb4',
    })
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_files (
        file_id VARCHAR(64) NOT NULL PRIMARY KEY,
        sha256 VARCHAR(64) NOT NULL,
        size BIGINT NOT NULL,
        format VARCHAR(16) NOT NULL,
        created_at VARCHAR(32) NOT NULL,
        storage_state VARCHAR(16) NOT NULL DEFAULT 'stored',
        verified_at BIGINT NULL,
        KEY idx_parse_files_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS library_entries (
        id CHAR(36) NOT NULL PRIMARY KEY,
        -- Nullable so a soft-deleted history row stops referencing (and blocking)
        -- the source file; the tombstone keeps identity for audit/backup.
        file_id VARCHAR(64) NULL,
        display_name VARCHAR(255) NOT NULL,
        library_scope VARCHAR(32) NOT NULL DEFAULT 'instance',
        retention VARCHAR(16) NOT NULL DEFAULT 'saved',
        deleted_at BIGINT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        UNIQUE KEY uq_library_file (file_id),
        KEY idx_library_deleted (deleted_at),
        KEY idx_library_created (created_at, id),
        CONSTRAINT fk_library_file FOREIGN KEY (file_id) REFERENCES parse_files(file_id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_sessions (
        id CHAR(36) NOT NULL PRIMARY KEY,
        file_id VARCHAR(64) NOT NULL,
        width INT NOT NULL,
        parser_version VARCHAR(64) NOT NULL,
        -- Legacy v1 copies are nullable: new records reference the artifact.
        base_url TEXT NULL,
        model JSON NULL,
        fonts JSON NULL,
        created_at BIGINT NOT NULL,
        last_used BIGINT NOT NULL,
        artifact_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        expires_at BIGINT NULL,
        format VARCHAR(8) NULL,
        layout_prefs JSON NULL,
        KEY idx_parse_sessions_file (file_id),
        KEY idx_parse_sessions_used (last_used)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_pending_sessions (
        id CHAR(36) NOT NULL PRIMARY KEY,
        file_id VARCHAR(64) NOT NULL,
        last_used BIGINT NOT NULL,
        record JSON NOT NULL,
        KEY idx_pending_file (file_id),
        KEY idx_pending_used (last_used),
        CONSTRAINT fk_pending_file FOREIGN KEY (file_id) REFERENCES parse_files(file_id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_chunk_manifests (
        session_id CHAR(36) NOT NULL PRIMARY KEY,
        file_id VARCHAR(64) NOT NULL,
        parser_version VARCHAR(64) NOT NULL,
        unit_count INT NOT NULL,
        chunk_blocks INT NOT NULL,
        manifest JSON NOT NULL,
        updated_at BIGINT NOT NULL,
        KEY idx_parse_chunks_file (file_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_artifacts (
        artifact_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        file_id VARCHAR(64) NOT NULL,
        identity JSON NOT NULL,
        state VARCHAR(16) NOT NULL,
        generation BIGINT UNSIGNED NOT NULL DEFAULT 0,
        ready_generation BIGINT UNSIGNED NULL,
        storage_path VARCHAR(512) NULL,
        manifest_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        unit_count INT UNSIGNED NOT NULL DEFAULT 0,
        last_access_at BIGINT NOT NULL,
        error_code VARCHAR(64) NULL,
        KEY idx_artifacts_file (file_id),
        KEY idx_artifacts_access (state, last_access_at),
        CONSTRAINT fk_artifact_file FOREIGN KEY (file_id) REFERENCES parse_files(file_id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_jobs (
        job_id CHAR(36) NOT NULL PRIMARY KEY,
        artifact_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        state VARCHAR(16) NOT NULL,
        attempt BIGINT UNSIGNED NOT NULL,
        generation BIGINT UNSIGNED NOT NULL,
        lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
        lease_until BIGINT NULL,
        progress INT UNSIGNED NOT NULL DEFAULT 0,
        error_code VARCHAR(64) NULL,
        UNIQUE KEY uq_job_artifact (artifact_key),
        KEY idx_jobs_lease (state, lease_until),
        CONSTRAINT fk_job_artifact FOREIGN KEY (artifact_key) REFERENCES parse_artifacts(artifact_key) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_artifact_read_leases (
        id CHAR(36) NOT NULL PRIMARY KEY,
        artifact_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        generation BIGINT UNSIGNED NOT NULL,
        lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        lease_until BIGINT NOT NULL,
        KEY idx_read_generation (artifact_key, generation, lease_until),
        KEY idx_read_expiry (lease_until),
        CONSTRAINT fk_read_artifact FOREIGN KEY (artifact_key) REFERENCES parse_artifacts(artifact_key) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_artifact_retirements (
        artifact_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        generation BIGINT UNSIGNED NOT NULL,
        retired_at BIGINT NOT NULL,
        PRIMARY KEY (artifact_key, generation),
        CONSTRAINT fk_retired_artifact FOREIGN KEY (artifact_key) REFERENCES parse_artifacts(artifact_key) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_artifact_flat_archives (
        artifact_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        generation BIGINT UNSIGNED NOT NULL,
        manifest_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        archived_at BIGINT NOT NULL,
        CONSTRAINT fk_flat_archive_artifact FOREIGN KEY (artifact_key) REFERENCES parse_artifacts(artifact_key) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    // Tombstones deliberately have NO foreign key to parse_artifacts: deleting
    // the directory row is what releases the source-file FK, and the high-water
    // generation must survive that deletion so claim() can never reuse g-1.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_artifact_archives (
        artifact_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        file_id VARCHAR(64) NOT NULL,
        generation BIGINT UNSIGNED NOT NULL,
        retired_generations BIGINT UNSIGNED NOT NULL DEFAULT 0,
        flat_archived TINYINT(1) NOT NULL DEFAULT 0,
        archived_at BIGINT NOT NULL,
        KEY idx_artifact_archive_file (file_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_idempotency (
        scope VARCHAR(32) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        body JSON NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        PRIMARY KEY (scope, idempotency_key),
        KEY idx_idempotency_expiry (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_pending_readers (
        session_id CHAR(36) NOT NULL,
        reader_id CHAR(36) NOT NULL,
        expires_at BIGINT NOT NULL,
        PRIMARY KEY (session_id, reader_id),
        KEY idx_pending_reader_expiry (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_artifact_dependencies (
        artifact_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        dependency_type VARCHAR(16) NOT NULL,
        dependency_id VARCHAR(128) NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (artifact_key, dependency_type, dependency_id),
        KEY idx_artifact_dependency_target (dependency_type, dependency_id),
        CONSTRAINT fk_dependency_artifact FOREIGN KEY (artifact_key)
          REFERENCES parse_artifacts(artifact_key) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    // Staged migration (plan §5/§10): add the columns before code depends on
    // them; the legacy base_url/model/fonts columns stay until v1 retires.
    await this.addColumn(
      'parse_sessions',
      'artifact_key',
      'CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL',
    )
    await this.addColumn('parse_sessions', 'expires_at', 'BIGINT NULL')
    await this.addColumn('parse_sessions', 'format', 'VARCHAR(8) NULL')
    await this.addColumn('parse_sessions', 'layout_prefs', 'JSON NULL')
    // Plan §5: library scope/retention/soft-delete and source-state columns.
    await this.addColumn('library_entries', 'library_scope', "VARCHAR(32) NOT NULL DEFAULT 'instance'")
    await this.addColumn('library_entries', 'retention', "VARCHAR(16) NOT NULL DEFAULT 'saved'")
    await this.addColumn('library_entries', 'deleted_at', 'BIGINT NULL')
    await this.ensureNullableColumn('library_entries', 'file_id', 'VARCHAR(64)')
    await this.addColumn('parse_files', 'storage_state', "VARCHAR(16) NOT NULL DEFAULT 'stored'")
    await this.addColumn('parse_files', 'verified_at', 'BIGINT NULL')
    // New records reference the shared artifact instead of copying the full
    // model/fonts into SQL; the legacy columns stay (nullable) for old rows and
    // for a rollback window, but are no longer written by this release.
    await this.ensureNullableColumn('parse_sessions', 'base_url', 'TEXT')
    await this.ensureNullableColumn('parse_sessions', 'model', 'JSON')
    await this.ensureNullableColumn('parse_sessions', 'fonts', 'JSON')
  }

  /** Relax a legacy NOT NULL column; no-op when already nullable or absent. */
  private async ensureNullableColumn(
    table: string,
    column: string,
    type: string,
  ): Promise<void> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT IS_NULLABLE FROM information_schema.COLUMNS " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1",
      [table, column],
    )
    if (rows.length === 0) return
    if (String(rows[0].IS_NULLABLE).toUpperCase() === 'YES') return
    await this.pool.query("ALTER TABLE `" + table + "` MODIFY COLUMN `" + column + "` " + type + " NULL")
  }

  /** Idempotent ADD COLUMN for deployments created by an older release. */
  private async addColumn(table: string, column: string, definition: string): Promise<void> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT 1 FROM information_schema.COLUMNS " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1",
      [table, column],
    )
    if (rows.length > 0) return
    await this.pool.query("ALTER TABLE `" + table + "` ADD COLUMN `" + column + "` " + definition)
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1')
      return true
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
