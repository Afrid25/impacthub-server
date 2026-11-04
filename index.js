import express from "express";

const app = express();
const PORT = 4500;

//http://localhost:4500

app.get("/", (req, res) => {
  res.send("Hello World");
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
})