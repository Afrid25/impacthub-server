
import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";
import cors from "cors";
import { createRemoteJWKSet, jwtVerify } from "jose";

dotenv.config();

const app = express();
const CLIENT_URL = process.env.CLIENT_URL;

if (!CLIENT_URL) {
  throw new Error("CLIENT_URL is missing in .env");
}

if (!process.env.DB_URL) {
  throw new Error("DB_URL is missing in .env");
}

// Use the origin only (no path, no trailing slash). The browser sends
// "https://app.vercel.app" and CORS compares it as an exact string, so a
// CLIENT_URL like "https://app.vercel.app/" would never match.
const CLIENT_ORIGIN = new URL(CLIENT_URL).origin;

app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json());

const PORT = process.env.PORT || 4500;

// ---------- MongoDB ----------
const client = new MongoClient(process.env.DB_URL);
await client.connect();

const db = client.db("impacthub");
const eventsCollection = db.collection("events");
const joiningCollection = db.collection("joinedEvents");

try {
  await joiningCollection.createIndex(
    { eventId: 1, userId: 1 },
    {
      name: "unique_event_participant",
      unique: true,
      partialFilterExpression: { userId: { $gt: "" } },
    }
  );
} catch (e) {
  console.error("Index error:", e.message);
}

// ---------- Authentication ----------
// Better Auth (running inside the Next.js app) signs a JWT for the logged-in
// user. We verify its signature against the public keys published at
// /api/auth/jwks. Better Auth sets the issuer and audience to its own origin,
// so CLIENT_URL here must be the same origin as BETTER_AUTH_URL in the client.
const jwks = createRemoteJWKSet(
  new URL(`${CLIENT_ORIGIN}/api/auth/jwks`)
);

async function verifyJwt(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      message: "Unauthorized: missing token",
    });
  }

  try {
    const { payload } = await jwtVerify(authHeader.slice(7), jwks, {
      issuer: CLIENT_ORIGIN,
      audience: CLIENT_ORIGIN,
      clockTolerance: 30,
    });

    // Identity comes ONLY from the verified token, never from the request body.
    req.user = {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      image: payload.image,
    };

    next();
  } catch (e) {
    if (e.code === "ERR_JWT_EXPIRED") {
      return res.status(401).json({
        message: "Session expired. Please log in again.",
      });
    }

    // A bad token (wrong signature, issuer, audience, format...) is the
    // caller's fault -> 401. Anything else (for example the public keys could
    // not be downloaded) is our fault -> 503, so users are not told they are
    // logged out when the real problem is a configuration or network issue.
    const isTokenProblem =
      typeof e.code === "string" &&
      e.code.startsWith("ERR_J") &&
      e.code !== "ERR_JWKS_TIMEOUT" &&
      e.code !== "ERR_JWKS_INVALID";

    if (isTokenProblem) {
      return res.status(401).json({
        message: "Unauthorized: invalid token",
      });
    }

    console.error("JWT verification unavailable:", e.code || e.message);
    res.status(503).json({
      message: "Authentication service unavailable",
    });
  }
}

// ---------- Helpers ----------
// Records owned by the verified user. The email fallback only applies to old
// records saved without a userId (null, "" or missing).
const ownerFilter = (user) => ({
  $or: [
    { userId: user.id },
    { userEmail: user.email, userId: { $in: [null, ""] } },
  ],
});

// Same rule as ownerFilter, for a record that is already loaded.
const isOwner = (record, user) =>
  record.userId === user.id ||
  (!record.userId && !!record.userEmail && record.userEmail === user.email);

const today = () => new Date().toISOString().slice(0, 10);

const isValidDate = (value) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const isHttpUrl = (value) => {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

// All six fields are required. Only these fields can ever be written, so
// ownership fields (userId, userEmail, userName) cannot be changed by a client.
const EVENT_RULES = {
  title: { max: 120 },
  eventType: { max: 50 },
  date: {},
  location: { max: 200 },
  thumbnail: { max: 2048 },
  description: { max: 5000 },
};

// requireAll = true  -> creating an event (every field needed, date must be in the future)
// requireAll = false -> editing an event (only sent fields are checked, date cannot be in the past)
function validateUpdates(body, requireAll = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object" };
  }

  const updates = {};

  for (const [field, rule] of Object.entries(EVENT_RULES)) {
    if (body[field] === undefined) {
      if (requireAll) {
        return { error: `${field} is required` };
      }
      continue;
    }

    if (typeof body[field] !== "string") {
      return { error: `${field} must be a string` };
    }

    const value = body[field].trim();

    if (!value) {
      return { error: `${field} is required` };
    }

    if (rule.max && value.length > rule.max) {
      return { error: `${field} must be at most ${rule.max} characters` };
    }

    if (field === "date") {
      if (!isValidDate(value)) {
        return { error: "date must be a valid date in YYYY-MM-DD format" };
      }
      if (requireAll && value <= today()) {
        return { error: "Event date must be in the future" };
      }
      if (!requireAll && value < today()) {
        return { error: "Event date cannot be in the past" };
      }
    }

    if (field === "thumbnail" && !isHttpUrl(value)) {
      return { error: "thumbnail must be a valid http(s) URL" };
    }

    updates[field] = value;
  }

  if (Object.keys(updates).length === 0) {
    return { error: "No valid fields to update" };
  }

  return { updates };
}

function isValidId(id) {
  return ObjectId.isValid(id);
}

// ---------- Get All Events ----------
app.get("/all-events", async (req, res) => {
  try {
    const limit = Number.parseInt(req.query.limit, 10);
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";
    const category =
      typeof req.query.category === "string"
        ? req.query.category.trim()
        : typeof req.query.eventType === "string"
          ? req.query.eventType.trim()
          : "";

    const query = { date: { $gte: today() } };

    if (category && category !== "All Categories") {
      query.eventType = category;
    }

    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = [
        { title: { $regex: escaped, $options: "i" } },
        { location: { $regex: escaped, $options: "i" } },
      ];
    }

    let cursor = eventsCollection.find(query).sort({ date: 1 });

    if (Number.isInteger(limit) && limit > 0) {
      cursor = cursor.limit(limit);
    }

    res.send(await cursor.toArray());
  } catch (e) {
    console.error(e);
    res.status(500).json({
      message: "Failed to load events",
    });
  }
});

// ---------- Get Event Details ----------
app.get("/all-events/:id", async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({
        message: "Invalid event ID",
      });
    }

    const result = await eventsCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!result) {
      return res.status(404).json({
        message: "Event not found",
      });
    }

    res.send(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({
      message: "Failed to load event",
    });
  }
});

// ---------- Add Event ----------
app.post("/add-events", verifyJwt, async (req, res) => {
  try {
    const { updates, error } = validateUpdates(req.body, true);

    if (error) {
      return res.status(400).json({ message: error });
    }

    const result = await eventsCollection.insertOne({
      title: updates.title,
      eventType: updates.eventType,
      date: updates.date,
      location: updates.location ?? "",
      thumbnail: updates.thumbnail ?? "",
      description: updates.description ?? "",
      userId: req.user.id,
      userEmail: req.user.email,
      userName: req.user.name || "",
    });

    res.status(201).send(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({
      message: "Failed to create event",
    });
  }
});

// ---------- My Created Events ----------
app.get("/my-events", verifyJwt, async (req, res) => {
  try {
    const result = await eventsCollection
      .find(ownerFilter(req.user))
      .sort({ date: 1 })
      .toArray();

    res.send(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({
      message: "Failed to load created events",
    });
  }
});

// ---------- My Joined Events ----------
app.get("/joined-events/:email", verifyJwt, async (req, res) => {
  try {
    if (req.params.email !== req.user.email) {
      return res.status(403).json({
        message: "Access denied",
      });
    }

    const result = await joiningCollection
      .find(ownerFilter(req.user))
      .sort({ date: 1 })
      .toArray();

    res.send(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({
      message: "Failed to load joined events",
    });
  }
});

// ---------- Join Event ----------
app.post("/joined", verifyJwt, async (req, res) => {
  try {
    const eventId = String(req.body?.eventId || "");

    if (!isValidId(eventId)) {
      return res.status(400).json({
        message: "Invalid event ID",
      });
    }

    const event = await eventsCollection.findOne({
      _id: new ObjectId(eventId),
    });

    if (!event) {
      return res.status(404).json({
        message: "Event not found",
      });
    }

    const alreadyJoined = await joiningCollection.findOne({
      eventId,
      ...ownerFilter(req.user),
    });

    if (alreadyJoined) {
      return res.status(409).json({
        message: "You have already joined this event",
      });
    }

    const result = await joiningCollection.insertOne({
      bookingDate: new Date().toISOString(),
      eventId,
      eventType: event.eventType ?? "",
      title: event.title ?? "",
      description: event.description ?? "",
      date: event.date ?? event.data ?? "",
      location: event.location ?? "",
      thumbnail: event.thumbnail ?? "",
      userId: req.user.id,
      userName: req.user.name || "",
      userEmail: req.user.email,
      userImage: req.user.image || "",
    });

    res.status(201).send(result);
  } catch (e) {
    if (e?.code === 11000) {
      return res.status(409).json({
        message: "You have already joined this event",
      });
    }

    console.error(e);
    res.status(500).json({
      message: "Failed to join event",
    });
  }
});

// ---------- Leave Joined Event ----------
app.delete("/delete-events/:id", verifyJwt, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({
        message: "Invalid joined event ID",
      });
    }

    const record = await joiningCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!record) {
      return res.status(404).json({
        message: "Joined event not found",
      });
    }

    if (!isOwner(record, req.user)) {
      return res.status(403).json({
        message: "Access denied",
      });
    }

    const result = await joiningCollection.deleteOne({
      _id: new ObjectId(req.params.id),
    });

    res.json({
      success: true,
      deletedCount: result.deletedCount,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      message: "Failed to leave event",
    });
  }
});

// ---------- Update Created Event ----------
app.patch("/update-events/:id", verifyJwt, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({
        message: "Invalid event ID",
      });
    }

    const { updates, error } = validateUpdates(req.body);

    if (error) {
      return res.status(400).json({ message: error });
    }

    const event = await eventsCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!event) {
      return res.status(404).json({
        message: "Event not found",
      });
    }

    if (!isOwner(event, req.user)) {
      return res.status(403).json({
        message: "Access denied",
      });
    }

    const result = await eventsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: updates }
    );

    res.json({
      success: true,
      modifiedCount: result.modifiedCount,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      message: "Failed to update event",
    });
  }
});

// ---------- Delete Created Event ----------
app.delete("/created-events/:id", verifyJwt, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({
        message: "Invalid event ID",
      });
    }

    const event = await eventsCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!event) {
      return res.status(404).json({
        message: "Event not found",
      });
    }

    if (!isOwner(event, req.user)) {
      return res.status(403).json({
        message: "Access denied",
      });
    }

    await eventsCollection.deleteOne({
      _id: new ObjectId(req.params.id),
    });

    res.json({
      success: true,
      message: "Event deleted successfully",
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      message: "Failed to delete event",
    });
  }
});

// ---------- Home ----------
app.get("/", (req, res) => {
  res.send("Hello World");
});

// ---------- Errors (always JSON, never an HTML page) ----------
app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Invalid JSON body" });
  }

  console.error(err);
  res.status(500).json({ message: "Internal server error" });
});

// ---------- Start Server ----------
if (process.env.VERCEL) {
  // Vercel handles incoming requests.
} else {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

export default app;
