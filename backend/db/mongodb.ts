import { MongoClient, Db } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "taskosphere_commercial";

let client: MongoClient | null = null;
let db: Db | null = null;
let connectPromise: Promise<Db> | null = null;

export function isMongoConfigured() {
  return Boolean(MONGODB_URI);
}

export async function getMongoDb(): Promise<Db> {
  if (db) return db;

  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is not configured");
  }

  if (!connectPromise) {
    connectPromise = (async () => {
      client = new MongoClient(MONGODB_URI, {
        maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 20),
        serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 5000),
      });

      await client.connect();
      db = client.db(MONGODB_DB_NAME);

      await db.collection("companies").createIndex({ slug: 1 }, { unique: true });
      await db.collection("users").createIndex({ company_id: 1, email: 1 }, { unique: true });
      await db.collection("subscriptions").createIndex({ company_id: 1 }, { unique: true });
      await db.collection("sessions").createIndex({ token_hash: 1 }, { unique: true });
      await db.collection("sessions").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

      return db;
    })().catch((error) => {
      connectPromise = null;
      client = null;
      db = null;
      throw error;
    });
  }

  return connectPromise;
}

export async function closeMongoDb() {
  if (client) {
    await client.close();
  }
  client = null;
  db = null;
  connectPromise = null;
}
