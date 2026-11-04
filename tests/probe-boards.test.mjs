import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBoard } from "../probe-boards.mjs";

test("detectBoard recognises the ATS behind a careers page", () => {
  assert.deepEqual(detectBoard('<a href="https://mdlz.wd3.myworkdayjobs.com/External/job/1">').provider, "workday");
  assert.equal(detectBoard('<img src="https://rmkcdn.successfactors.com/aaf0/x.png">').provider, "successfactors");
  assert.equal(detectBoard('<script src="https://cdn.phenompeople.com/CareerConnectResources/x.js">').provider, "phenom");
  assert.equal(detectBoard('href="https://careers.smartrecruiters.com/DeliveryHero"').provider, "smartrecruiters");
  assert.equal(detectBoard('"https://ehpv.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1"').provider, "oraclecloud");
  assert.equal(detectBoard("<html>no board here</html>"), null);
});
