import app from "./index.js";

const port = Number(process.env.PORT ?? 4100);
app.listen(port, () => console.log(`fx-api on http://localhost:${port}`));
