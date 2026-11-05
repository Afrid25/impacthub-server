import express from "express";
import { MongoClient, ObjectId } from 'mongodb';
import dotenv from "dotenv";
import cors from "cors";

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

const isHttpUrl = (value) => {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

// Returns { updates } on success or { error } with a client-safe message.
function validateEventUpdates(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object" };
  }

  const unknown = Object.keys(body).filter((key) => !(key in EVENT_UPDATE_RULES));
  if (unknown.length > 0) {
    return { error: `Fields not allowed: ${unknown.join(", ")}` };
  }

  const updates = {};
  for (const [field, rule] of Object.entries(EVENT_UPDATE_RULES)) {
    if (body[field] === undefined) continue;

    if (typeof body[field] !== "string") {
      return { error: `${field} must be a string` };
    }
    const value = body[field].trim();

    if (rule.required && !value) return { error: `${field} is required` };
    if (rule.max && value.length > rule.max) {
      return { error: `${field} must be at most ${rule.max} characters` };
    }
    if (rule.date && !isValidDateString(value)) {
      return { error: "date must be a valid date in YYYY-MM-DD format" };
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

// Prevent concurrent duplicate joins at the database level. Partial index:
// only records with a non-empty string userId are covered, so existing legacy
// records (no userId, including one known duplicate pair) are left untouched.
// createIndex is idempotent; a failure is logged but does not stop the server.
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
    const { _id, ...data } = req.body || {};
    // Creator identity always comes from the verified session.
    const result = await eventsCollection.insertOne({
      ...data,
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
    const result = await eventsCollection.find(ownerFilter(req.user)).toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to load created events" });
  }
});

app.get("/joined-events/:email", verifyAuth, async (req, res) => {
  const {email} = req.params;
  if (email !== req.user.email) {
    return res.status(403).json({ message: "Access denied" });
  }
  const result = await joiningCollection.find(ownerFilter(req.user)).toArray();
  res.send(result);
});

app.get("/all-events", async (req, res) => {
  const result = await eventsCollection.find({}).toArray();
  res.send(result);
});

app.post("/joined", verifyAuth, async (req, res) => {
  try {
    // Only eventId is taken from the client; everything else is server-derived.
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
      ...ownerFilter(req.user),
    });
    if (alreadyJoined) {
      return res.status(409).json({ message: "You have already joined this event" });
    }

    // Event details are copied from the verified original event document;
    // participant identity comes from the verified session.
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
app.delete("/delete-events/:id", verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid joined event ID",
      });
    }

    const result = await joiningCollection.deleteOne({
      _id: new ObjectId(id),
      ...ownerFilter(req.user),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        message: "Joined event not found",
      });
    }

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
app.patch("/update-events/:id", verifyAuth, async (req, res) => {
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

    const result = await eventsCollection.updateOne(
      {
        _id: new ObjectId(id),
        ...ownerFilter(req.user),
      },
      { $set: updates }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        message: "Event not found or access denied",
      });
    }

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

app.delete("/created-events/:id", verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid event ID",
      });
    }

    const result = await eventsCollection.deleteOne({
      _id: new ObjectId(id),
      ...ownerFilter(req.user),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        message: "Event not found or access denied",
      });
    }

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