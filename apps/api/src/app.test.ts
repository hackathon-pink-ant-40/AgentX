import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { openDatabase } from "./database.js";

describe("Customer MDM sandbox API", () => {
  let directory: string;
  let database: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agentx-api-"));
    database = openDatabase(join(directory, "test.sqlite"));
    app = createApp(database);
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("reports live service health and persisted record counts", async () => {
    const response = await request(app).get("/api/health").expect(200);
    expect(response.body).toEqual({
      status: "ok",
      service: "testagent-api",
      database: "connected",
      counts: { customers: 0, addresses: 0 },
    });
  });

  it("creates and reads a customer, while rejecting missing and duplicate IDs", async () => {
    await request(app)
      .post("/api/mock-api/customers")
      .send({ customerId: "cust-1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" })
      .expect(201)
      .expect(({ body }) => {
        expect(body.customer).toMatchObject({
          customerId: "cust-1",
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.test",
          status: "ACTIVE",
        });
      });

    await request(app).get("/api/mock-api/customers/cust-1").expect(200);
    await request(app).get("/api/mock-api/customers").expect(200).expect(({ body }) => {
      expect(body.customers).toHaveLength(1);
    });
    await request(app)
      .post("/api/mock-api/customers")
      .send({ customerId: "missing-name", lastName: "Customer" })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("VALIDATION_ERROR"));
    await request(app)
      .post("/api/mock-api/customers")
      .send({ customerId: "cust-1", firstName: "Another", lastName: "Person" })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("DUPLICATE_CUSTOMER_ID"));
  });

  it("validates address ownership, updates customers, and reparents addresses on merge", async () => {
    for (const customerId of ["survivor", "to-merge"]) {
      await request(app)
        .post("/api/mock-api/customers")
        .send({ customerId, firstName: customerId, lastName: "Example" })
        .expect(201);
    }

    await request(app)
      .post("/api/mock-api/addresses")
      .send({
        addressId: "addr-1",
        customerId: "to-merge",
        street: "1 Test Street",
        postalCode: "1234 AB",
        country: "nl",
      })
      .expect(201)
      .expect(({ body }) => expect(body.address.country).toBe("NL"));
    await request(app)
      .post("/api/mock-api/addresses")
      .send({ customerId: "unknown", street: "Nowhere", postalCode: "0000", country: "NL" })
      .expect(422)
      .expect(({ body }) => expect(body.error.code).toBe("UNKNOWN_CUSTOMER"));

    await request(app).patch("/api/mock-api/customers/survivor").send({ firstName: "Updated" }).expect(200);
    await request(app)
      .post("/api/mock-api/customers/merge")
      .send({ survivorId: "survivor", mergedId: "to-merge" })
      .expect(200)
      .expect(({ body }) => expect(body.reparentedAddressCount).toBe(1));
    await request(app)
      .get("/api/mock-api/customers/survivor/addresses")
      .expect(200)
      .expect(({ body }) => expect(body.addresses[0].customerId).toBe("survivor"));
    await request(app)
      .get("/api/mock-api/customers/to-merge")
      .expect(200)
      .expect(({ body }) => expect(body.customer.mergedInto).toBe("survivor"));
    await request(app)
      .delete("/api/mock-api/customers/survivor")
      .set("x-demo-sandbox", "true")
      .expect(409);
  });

  it("requires explicit sandbox confirmation before deletion", async () => {
    await request(app)
      .post("/api/mock-api/customers")
      .send({ customerId: "delete-me", firstName: "Test", lastName: "Customer" })
      .expect(201);

    await request(app).delete("/api/mock-api/customers/delete-me").expect(403);
    await request(app)
      .delete("/api/mock-api/customers/delete-me")
      .set("x-demo-sandbox", "true")
      .expect(204);
    await request(app).get("/api/mock-api/customers/delete-me").expect(404);
  });
});
