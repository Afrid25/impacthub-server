import express from "express";
import { MongoClient, ObjectId } from 'mongodb';
import dotenv from "dotenv";
import cors from "cors";
import { createRemoteJWKSet, jwtVerify } from "jose";

dotenv.config();

const app = express();
// Credentialed CORS so the browser can send the Better Auth session cookie.
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());
const PORT = 4500;

// Better Auth runs inside the Next.js app. Verify the caller by forwarding
// their cookies to Better Auth's own get-session endpoint (no second auth system).
const AUTH_SERVER_URL = process.env.AUTH_SERVER_URL || "http://localhost:3000";

async function verifyAuth(req, res, next) {
  try {
    const cookie = req.headers.cookie;
    if (!cookie) {
      return res.status(401).json({ message: "Unauthorized: please log in" });
    }

    const response = await fetch(`${AUTH_SERVER_URL}/api/auth/get-session`, {
      headers: { cookie },
    });

    const data = response.ok ? await response.json() : null;

    if (!data?.user?.id) {
      return res.status(401).json({ message: "Unauthorized: invalid session" });
    }

    req.user = data.user;
    next();
  } catch (error) {
    console.error("verifyAuth failed:", error);
    res.status(503).json({ message: "Authentication service unavailable" });
  }
}

// JWT authentication (Better Auth JWT plugin).
// Verifies Bearer tokens against the Better Auth JWKS endpoint and attaches the
// verified identity (from the `sub` claim) to req.user. Identity is never taken
// from the client.
const BASE_URL = process.env.BETTER_AUTH_URL || "http://localhost:3000";
const JWKS_URL = `${BASE_URL.replace(/\/$/, "")}/api/auth/jwks`;
const jwks = createRemoteJWKSet(new URL(JWKS_URL));

async function verifyJwt(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized: missing token" });
  }

  const token = authHeader.slice(7); // strip "Bearer "

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: BASE_URL.replace(/\/$/, ""),
      audience: BASE_URL.replace(/\/$/, ""),
      clockTolerance: 30, // allow 30s clock skew
    });

    // Identity always comes from the verified JWT `sub` claim.
    req.user = {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      image: payload.image,
    };

    next();
  } catch (error) {
    // Never log the token or any secrets.
    if (error.name === "TokenExpiredError" || error.code === "ERR_JWT_EXPIRED") {
      return res.status(401).json({ message: "Unauthorized: token expired" });
    }
    if (error.name === "JWTInvalid" || error.code === "ERR_JWS_INVALID") {
      return res.status(401).json({ message: "Unauthorized: invalid token" });
    }
    return res.status(401).json({ message: "Unauthorized: authentication failed" });
  }
}

// Records owned by the verified user. The email fallback applies ONLY to legacy
// records whose userId is missing, null, or "" (emails are unique in Better Auth).
// Records that carry a userId are matched strictly by that userId.
const ownerFilter = (user) => ({
  $or: [
    { userId: user.id },
    { userEmail: user.email, userId: { $in: [null, ""] } }, // null also matches missing
  ],
});

// Validation rules for PATCH /update-events/:id (all values are strings).
const EVENT_UPDATE_RULES = {
  title: { required: true, max: 120 },
  eventType: { required: true, max: 50 },
  date: { required: true, date: true },
  location: { max: 200 },
  thumbnail: { max: 2048, url: true },
  description: { max: 5000 },
};

const isValidDateString = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const getTodayString = () => new Date().toISOString().slice(0, 10);

const isHttpUrl = (value) => {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

// Returns { updates } on success or { error } with a client-safe message.
function validateEventUpdates(body, { requireAll = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object" };
  }

  if (!requireAll) {
    const unknown = Object.keys(body).filter((key) => !(key in EVENT_UPDATE_RULES));
    if (unknown.length > 0) {
      return { error: `Fields not allowed: ${unknown.join(", ")}` };
    }
  }

  const today = getTodayString();
  const updates = {};
  for (const [field, rule] of Object.entries(EVENT_UPDATE_RULES)) {
    if (body[field] === undefined) {
      if (requireAll && rule.required) {
        return { error: `${field} is required` };
      }
      continue;
    }

    if (typeof body[field] !== "string") {
      return { error: `${field} must be a string` };
    }
    const value = body[field].trim();

    if (rule.required && !value) return { error: `${field} is required` };
    if (rule.max && value.length > rule.max) {
      return { error: `${field} must be at most ${rule.max} characters` };
    }
    if (rule.date) {
      if (!isValidDateString(value)) {
        return { error: "date must be a valid date in YYYY-MM-DD format" };
      }
      if (value < today) {
        return { error: "Event date cannot be in the past" };
      }
    }
    if (rule.url && value && !isHttpUrl(value)) {
      return { error: "thumbnail must be a valid http(s) URL" };
    }

    updates[field] = value;
  }

  if (Object.keys(updates).length === 0) {
    return { error: "No valid fields to update" };
  }
  return { updates };
}

//http://localhost:4500/joined



const client = new MongoClient(process.env.DB_URL);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const mongnoClient = await connectToMongoDB();
const db = mongnoClient.db("impacthub");
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
} catch (error) {
  console.error("Could not ensure unique join index:", error.message);
}

app.post("/add-events", verifyAuth, async (req, res) => {
  try {
    const { updates: eventFields, error: validationError } = validateEventUpdates(
      req.body,
      { requireAll: true }
    );
    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    // Creator identity always comes from the verified session.
    const result = await eventsCollection.insertOne({
      title: eventFields.title,
      eventType: eventFields.eventType,
      date: eventFields.date,
      location: eventFields.location ?? "",
      thumbnail: eventFields.thumbnail ?? "",
      description: eventFields.description ?? "",
      userId: req.user.id,
      userEmail: req.user.email,
      userName: req.user.name || "",
    });
    res.status(201).send(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to create event" });
  }
});

// Events created by the authenticated user (Manage Events)
app.get("/my-events", verifyAuth, async (req, res) => {
  try {
    const result = await eventsCollection
      .find(ownerFilter(req.user))
      .sort({ date: 1 })
      .toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to load created events" });
  }
});

app.get("/joined-events/:email", verifyAuth, async (req, res) => {
  const { email } = req.params;
  if (email !== req.user.email) {
    return res.status(403).json({ message: "Access denied" });
  }
  // Sort joined records by the original event date ascending.
  const result = await joiningCollection
    .find(ownerFilter(req.user))
    .sort({ date: 1 })
    .toArray();
  res.send(result);
});

app.get("/all-events", async (req, res) => {
  try {

    const today = getTodayString();
    const limit = Number.parseInt(req.query.limit, 10);

    // Exclude past events and sort upcoming events by event date ascending.
    let cursor = eventsCollection
      .find({ date: { $gte: today } })
      .sort({ date: 1 });

    // Use MongoDB .limit() when requested (e.g. ?limit=6 for Recent Upcoming Events).
    if (Number.isInteger(limit) && limit > 0) {
      cursor = cursor.limit(limit);
    }

    const result = await cursor.toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to load events" });
  }
});

app.post("/joined", verifyJwt, async (req, res) => {
  try {
    // Only eventId is taken from the client; the participant userId comes from
    // the verified JWT (req.user.id). userId in req.body is never trusted.
    const eventId = String(req.body?.eventId || "");

    if (!ObjectId.isValid(eventId)) {
      return res.status(400).json({ message: "Invalid event ID" });
    }

    const event = await eventsCollection.findOne({ _id: new ObjectId(eventId) });
    if (!event) {
      return res.status(404).json({ message: "Event not found" });
    }

    // Fast path (also covers legacy email-only records not in the unique index).
    const alreadyJoined = await joiningCollection.findOne({
      eventId,
      userId: req.user.id,
    });
    if (alreadyJoined) {
      return res.status(409).json({ message: "You have already joined this event" });
    }

    // Event details are copied from the verified original event document;
    // participant identity comes from the verified JWT.
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
  } catch (error) {
    // Unique index rejected a concurrent duplicate join.
    if (error?.code === 11000) {
      return res.status(409).json({ message: "You have already joined this event" });
    }
    console.error(error);
    res.status(500).json({ message: "Failed to join event" });
  }
});


// Leave a joined event
app.delete("/delete-events/:id", verifyJwt, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid joined event ID",
      });
    }

    // Find the participation record and verify it belongs to the authenticated user.
    const record = await joiningCollection.findOne({ _id: new ObjectId(id) });
    if (!record) {
      return res.status(404).json({
        message: "Joined event not found",
      });
    }
    if (record.userId !== req.user.id) {
      return res.status(403).json({
        message: "Access denied: you can only leave your own participation",
      });
    }

    const result = await joiningCollection.deleteOne({ _id: new ObjectId(id) });

    res.json({
      success: true,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to leave event",
    });
  }
});

// Update my created event
app.patch("/update-events/:id", verifyJwt, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid event ID",
      });
    }

    const { updates, error: validationError } = validateEventUpdates(req.body);
    if (validationError) {
      return res.status(400).json({
        message: validationError,
      });
    }

    // Fetch the actual event and compare its owner with the verified user ID.
    const event = await eventsCollection.findOne({ _id: new ObjectId(id) });
    if (!event) {
      return res.status(404).json({
        message: "Event not found",
      });
    }
    if (event.userId !== req.user.id) {
      return res.status(403).json({
        message: "Access denied: you are not the owner of this event",
      });
    }

    // Only validated event fields are updated; userId is not an updatable field,
    // so event ownership can never be changed here.
    const result = await eventsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updates }
    );

    res.json({
      success: true,
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to update event",
    });
  }
});

app.delete("/created-events/:id", verifyJwt, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid event ID",
      });
    }

    // Fetch the actual event and verify the authenticated user is its owner.
    const event = await eventsCollection.findOne({ _id: new ObjectId(id) });
    if (!event) {
      return res.status(404).json({
        message: "Event not found",
      });
    }
    if (event.userId !== req.user.id) {
      return res.status(403).json({
        message: "Access denied: you are not the owner of this event",
      });
    }

    const result = await eventsCollection.deleteOne({ _id: new ObjectId(id) });

    res.json({
      success: true,
      message: "Event deleted successfully",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Failed to delete event",
    });
  }
});


app.get("/all-events/:id", async (req, res) => {
  const authorization = req.headers.authorization;

  console.log("Token received:", Boolean(authorization));
  const { id } = req.params;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid event ID" });
  }
  const result = await eventsCollection.findOne({ _id: new ObjectId(id) });
  if (!result) {
    return res.status(404).json({ message: "Event not found" });
  }
  res.send(result);
});


app.get("/", (req, res) => {
  res.send("Hello World");
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
})