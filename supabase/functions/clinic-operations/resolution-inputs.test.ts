import assert from "node:assert/strict";
import test from "node:test";
import { loadResolutionInputs } from "./resolution-inputs.ts";
import { createPerformanceTiming } from "./performance-timing.ts";

function mockDb(results: Record<string, { data: unknown; error: Error | null }>) {
  const started: string[] = [];
  const filters: Record<string, Array<[string, unknown]>> = {};
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    started,
    filters,
    get maxInFlight() {
      return maxInFlight;
    },
    from(table: string) {
      filters[table] = [];
      const query = {
        select(_fields: string) {
          return query;
        },
        eq(field: string, value: unknown) {
          filters[table].push([field, value]);
          return query;
        },
        then(resolve: (result: { data: unknown; error: Error | null }) => void) {
          started.push(table);
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          return new Promise<void>((done) =>
            setImmediate(() => {
              resolve(results[table]);
              inFlight--;
              done();
            }),
          );
        },
      };
      return query;
    },
  };
}

const timing = () =>
  createPerformanceTiming(
    () => 0,
    () => {},
  );

test("resolution reads start together, retain clinic filters, and preserve alias grouping", async () => {
  const staff = [
    {
      id: "staff-a",
      full_name: "A",
      specialty: "Dentist",
      services: ["Consultation"],
      aliases: [],
    },
  ];
  const db = mockDb({
    staff: { data: staff, error: null },
    clinic_service_aliases: {
      data: [
        { service: "Consultation", alias: "consult" },
        { service: "Consultation", alias: "استشارة" },
      ],
      error: null,
    },
  });
  const result = await loadResolutionInputs(db, "clinic-a", timing());
  assert.deepEqual(db.started, ["staff", "clinic_service_aliases"]);
  assert.equal(db.maxInFlight, 2);
  assert.deepEqual(db.filters.staff, [
    ["clinic_id", "clinic-a"],
    ["active", true],
  ]);
  assert.deepEqual(db.filters.clinic_service_aliases, [["clinic_id", "clinic-a"]]);
  assert.deepEqual(result, { staff, aliases: { Consultation: ["consult", "استشارة"] } });
});

test("either failed read blocks resolution", async () => {
  for (const failed of ["staff", "clinic_service_aliases"]) {
    const error = new Error(`${failed} unavailable`);
    const db = mockDb({
      staff: { data: [], error: failed === "staff" ? error : null },
      clinic_service_aliases: {
        data: [],
        error: failed === "clinic_service_aliases" ? error : null,
      },
    });
    await assert.rejects(loadResolutionInputs(db, "clinic-a", timing()), error);
  }
});

test("concurrent transport failures retain staff-first error priority", async () => {
  const staffError = new Error("staff transport failed");
  const aliasError = new Error("alias transport failed");
  const db = {
    from(table: string) {
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        then(_resolve: unknown, reject: (error: Error) => void) {
          queueMicrotask(() => reject(table === "staff" ? staffError : aliasError));
        },
      };
      return query;
    },
  };
  await assert.rejects(loadResolutionInputs(db, "clinic-a", timing()), staffError);
});
