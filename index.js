import express from "express";
import { MongoClient, ObjectId } from 'mongodb';
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
const PORT = 4500;

//http://localhost:4500/



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

app.post("/add-events",  (req, res) => {
  const data = req.body;
  const result = eventsCollection.insertOne(data);
  console.log(result);
  res.send(result);
});

app.get("/all-events", async (req, res) => {
  const result = await eventsCollection.find({}).toArray();
  res.send(result);
});

app.get("/all-events/:id", async (req, res) => {
  const { id } = req.params;
  const result = await eventsCollection.findOne({ _id: new ObjectId(id) });
  res.send(result);
});

app.get("/", (req, res) => {
  res.send("Hello World");
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
})