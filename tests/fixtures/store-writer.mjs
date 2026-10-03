import { UsageStore } from "../../lib/store.js";

const [file, id, repetitions] = process.argv.slice(2);
const store = new UsageStore(file, (error) => { throw error; });
process.once("message", () => {
  for (let i = 0; i < Number(repetitions); i++) {
    if (!store.record("shared", i) || !store.record(`writer-${id}`, i)) process.exit(1);
  }
  process.disconnect();
});
process.send("ready");
