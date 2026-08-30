import { loadArchiveSnapshot } from "../src/db.js";
import { assertPublicationAllowed } from "../src/publication.js";

try {
  const review = assertPublicationAllowed(loadArchiveSnapshot(), process.env.AA_REDISTRIBUTION_LICENSE_CONFIRMED);
  console.log(JSON.stringify({ publication: "allowed", ...review }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
