import { randomUUID } from "node:crypto";
import type {
  Address,
  AddressListResponse,
  AddressResponse,
  CreateAddressRequest,
  CreateCustomerRequest,
  Customer,
  CustomerResponse,
  CustomerListResponse,
  CustomerStatus,
  MergeCustomersRequest,
  MergeCustomersResponse,
  PatchCustomerRequest,
} from "@agentx/shared";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import type Database from "better-sqlite3";

interface CustomerRow {
  customer_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  status: CustomerStatus;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
}

interface AddressRow {
  address_id: string;
  customer_id: string;
  street: string;
  postal_code: string;
  country: string;
  created_at: string;
}

class ApiFault extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
  }
}

const customerStatuses = new Set<CustomerStatus>(["ACTIVE", "INACTIVE", "PROSPECT"]);
const customerFields = new Set(["customerId", "firstName", "lastName", "email", "status"]);
const patchableFields = new Set(["firstName", "lastName", "email", "status"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  maximumLength = 200,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiFault(400, "VALIDATION_ERROR", `${field} is required`, { [field]: "required" });
  }
  const trimmed = value.trim();
  if (trimmed.length > maximumLength) {
    throw new ApiFault(400, "VALIDATION_ERROR", `${field} must be ${maximumLength} characters or fewer`, {
      [field]: "too_long",
    });
  }
  return trimmed;
}

function optionalString(value: unknown, field: string, maximumLength = 320): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximumLength) {
    throw new ApiFault(400, "VALIDATION_ERROR", `${field} must be a non-empty string of at most ${maximumLength} characters`, {
      [field]: "invalid",
    });
  }
  return value.trim();
}

function assertKnownFields(body: Record<string, unknown>, allowed: Set<string>): void {
  const unknownFields = Object.keys(body).filter((field) => !allowed.has(field));
  if (unknownFields.length > 0) {
    throw new ApiFault(400, "VALIDATION_ERROR", `Unsupported field: ${unknownFields.join(", ")}`, {
      fields: "unsupported",
    });
  }
}

function parseStatus(value: unknown): CustomerStatus {
  if (typeof value !== "string" || !customerStatuses.has(value as CustomerStatus)) {
    throw new ApiFault(400, "VALIDATION_ERROR", "status must be ACTIVE, INACTIVE, or PROSPECT", {
      status: "invalid",
    });
  }
  return value as CustomerStatus;
}

function toCustomer(row: CustomerRow): Customer {
  return {
    customerId: row.customer_id,
    firstName: row.first_name,
    lastName: row.last_name,
    ...(row.email === null ? {} : { email: row.email }),
    status: row.status,
    ...(row.merged_into === null ? {} : { mergedInto: row.merged_into }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAddress(row: AddressRow): Address {
  return {
    addressId: row.address_id,
    customerId: row.customer_id,
    street: row.street,
    postalCode: row.postal_code,
    country: row.country,
    createdAt: row.created_at,
  };
}

function getCustomer(database: Database.Database, customerId: string): CustomerRow | undefined {
  return database
    .prepare("SELECT * FROM customers WHERE customer_id = ?")
    .get(customerId) as CustomerRow | undefined;
}

function requireCustomer(database: Database.Database, customerId: string): CustomerRow {
  const customer = getCustomer(database, customerId);
  if (!customer) {
    throw new ApiFault(404, "CUSTOMER_NOT_FOUND", `Customer ${customerId} was not found`);
  }
  return customer;
}

function routeParameter(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== "string") {
    throw new ApiFault(400, "VALIDATION_ERROR", `Invalid ${name} path parameter`);
  }
  return value;
}

function wrap(
  handler: (request: Request, response: Response) => void,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    try {
      handler(request, response);
    } catch (error) {
      next(error);
    }
  };
}

export function createMockMdmRouter(database: Database.Database): Router {
  const router = Router();

  router.get("/", (_request, response) => {
    response.json({
      service: "Customer MDM sandbox",
      sandboxOnly: true,
      endpoints: [
        "GET /customers",
        "POST /customers",
        "GET /customers/:id",
        "PATCH /customers/:id",
        "POST /customers/merge",
        "DELETE /customers/:id (requires x-demo-sandbox: true)",
        "POST /addresses",
        "GET /customers/:id/addresses",
      ],
    });
  });

  router.get("/customers", wrap((_request, response) => {
    const rows = database
      .prepare("SELECT * FROM customers ORDER BY created_at, customer_id LIMIT 100")
      .all() as CustomerRow[];
    const result: CustomerListResponse = { customers: rows.map(toCustomer) };
    response.json(result);
  }));

  router.post("/customers", wrap((request, response) => {
    if (!isRecord(request.body)) {
      throw new ApiFault(400, "VALIDATION_ERROR", "Request body must be a JSON object");
    }
    assertKnownFields(request.body, customerFields);

    const input: CreateCustomerRequest = {
      customerId: requiredString(request.body.customerId, "customerId"),
      firstName: requiredString(request.body.firstName, "firstName"),
      lastName: requiredString(request.body.lastName, "lastName"),
      ...(request.body.email === undefined ? {} : { email: optionalString(request.body.email, "email") ?? undefined }),
      status: request.body.status === undefined ? "ACTIVE" : parseStatus(request.body.status),
    };
    const existing = getCustomer(database, input.customerId);
    if (existing) {
      throw new ApiFault(409, "DUPLICATE_CUSTOMER_ID", `Customer ${input.customerId} already exists`);
    }

    const now = new Date().toISOString();
    database
      .prepare(`
        INSERT INTO customers (customer_id, first_name, last_name, email, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(input.customerId, input.firstName, input.lastName, input.email ?? null, input.status, now, now);

    const result: CustomerResponse = { customer: toCustomer(requireCustomer(database, input.customerId)) };
    response.status(201).json(result);
  }));

  router.post("/customers/merge", wrap((request, response) => {
    if (!isRecord(request.body)) {
      throw new ApiFault(400, "VALIDATION_ERROR", "Request body must be a JSON object");
    }
    assertKnownFields(request.body, new Set(["survivorId", "mergedId"]));
    const input: MergeCustomersRequest = {
      survivorId: requiredString(request.body.survivorId, "survivorId"),
      mergedId: requiredString(request.body.mergedId, "mergedId"),
    };
    const { survivorId, mergedId } = input;
    if (survivorId === mergedId) {
      throw new ApiFault(422, "INVALID_MERGE", "survivorId and mergedId must be different");
    }

    const survivor = requireCustomer(database, survivorId);
    const merged = requireCustomer(database, mergedId);
    if (survivor.merged_into !== null || merged.merged_into !== null) {
      throw new ApiFault(422, "INVALID_MERGE", "Already-merged customers cannot be merged again");
    }

    const now = new Date().toISOString();
    const merge = database.transaction(() => {
      const regression = database.prepare("SELECT value FROM demo_settings WHERE key = 'regression'").get() as { value: string };
      const reparentedAddressCount = regression.value === "true" ? 0 : database
        .prepare("UPDATE addresses SET customer_id = ? WHERE customer_id = ?")
        .run(survivorId, mergedId).changes;
      database
        .prepare("UPDATE customers SET merged_into = ?, updated_at = ? WHERE customer_id = ?")
        .run(survivorId, now, mergedId);
      database
        .prepare("UPDATE customers SET updated_at = ? WHERE customer_id = ?")
        .run(now, survivorId);
      return {
        survivor: requireCustomer(database, survivorId),
        merged: requireCustomer(database, mergedId),
        reparentedAddressCount,
      };
    });

    const mergeResult = merge();
    const result: MergeCustomersResponse = {
      survivor: toCustomer(mergeResult.survivor),
      merged: toCustomer(mergeResult.merged),
      reparentedAddressCount: mergeResult.reparentedAddressCount,
    };
    response.json(result);
  }));

  router.get("/customers/:id/addresses", wrap((request, response) => {
    const customerId = routeParameter(request, "id");
    requireCustomer(database, customerId);
    const rows = database
      .prepare("SELECT * FROM addresses WHERE customer_id = ? ORDER BY created_at, address_id")
      .all(customerId) as AddressRow[];
    const result: AddressListResponse = { addresses: rows.map(toAddress) };
    response.json(result);
  }));

  router.get("/customers/:id", wrap((request, response) => {
    const customerId = routeParameter(request, "id");
    const customer = getCustomer(database, customerId);
    if (!customer) {
      throw new ApiFault(404, "CUSTOMER_NOT_FOUND", `Customer ${customerId} was not found`);
    }
    const result: CustomerResponse = { customer: toCustomer(customer) };
    response.json(result);
  }));

  router.patch("/customers/:id", wrap((request, response) => {
    if (!isRecord(request.body)) {
      throw new ApiFault(400, "VALIDATION_ERROR", "Request body must be a JSON object");
    }
    assertKnownFields(request.body, patchableFields);
    const customerId = routeParameter(request, "id");
    const current = requireCustomer(database, customerId);
    if (current.merged_into !== null) {
      throw new ApiFault(409, "CUSTOMER_MERGED", "A merged customer cannot be updated");
    }
    if (Object.keys(request.body).length === 0) {
      throw new ApiFault(400, "VALIDATION_ERROR", "At least one customer field is required");
    }

    const input: PatchCustomerRequest = {
      ...(request.body.firstName === undefined
        ? {}
        : { firstName: requiredString(request.body.firstName, "firstName") }),
      ...(request.body.lastName === undefined
        ? {}
        : { lastName: requiredString(request.body.lastName, "lastName") }),
      ...(request.body.email === undefined
        ? {}
        : { email: optionalString(request.body.email, "email") }),
      ...(request.body.status === undefined ? {} : { status: parseStatus(request.body.status) }),
    };
    const firstName = input.firstName ?? current.first_name;
    const lastName = input.lastName ?? current.last_name;
    const email = input.email === undefined ? current.email : input.email;
    const status = input.status ?? current.status;
    const now = new Date().toISOString();

    database
      .prepare(`
        UPDATE customers SET first_name = ?, last_name = ?, email = ?, status = ?, updated_at = ?
        WHERE customer_id = ?
      `)
      .run(firstName, lastName, email, status, now, customerId);
    const result: CustomerResponse = { customer: toCustomer(requireCustomer(database, customerId)) };
    response.json(result);
  }));

  router.delete("/customers/:id", wrap((request, response) => {
    if (request.header("x-demo-sandbox") !== "true") {
      throw new ApiFault(403, "SANDBOX_CONFIRMATION_REQUIRED", "Deletion requires x-demo-sandbox: true");
    }
    const customerId = routeParameter(request, "id");
    const customer = requireCustomer(database, customerId);
    if (customer.merged_into !== null) {
      throw new ApiFault(409, "CUSTOMER_MERGED", "A merged customer cannot be deleted");
    }
    const mergedRecords = database
      .prepare("SELECT COUNT(*) AS count FROM customers WHERE merged_into = ?")
      .get(customerId) as { count: number };
    if (mergedRecords.count > 0) {
      throw new ApiFault(409, "CUSTOMER_HAS_MERGED_RECORDS", "A survivor with merged customer records cannot be deleted");
    }
    database.prepare("DELETE FROM customers WHERE customer_id = ?").run(customerId);
    response.status(204).end();
  }));

  router.post("/addresses", wrap((request, response) => {
    if (!isRecord(request.body)) {
      throw new ApiFault(400, "VALIDATION_ERROR", "Request body must be a JSON object");
    }
    assertKnownFields(request.body, new Set(["addressId", "customerId", "street", "postalCode", "country"]));
    const input: CreateAddressRequest = {
      ...(request.body.addressId === undefined ? {} : { addressId: requiredString(request.body.addressId, "addressId") }),
      customerId: requiredString(request.body.customerId, "customerId"),
      street: requiredString(request.body.street, "street"),
      postalCode: requiredString(request.body.postalCode, "postalCode"),
      country: requiredString(request.body.country, "country", 2).toUpperCase(),
    };
    const addressId = input.addressId ?? randomUUID();
    const { customerId, street, postalCode, country } = input;
    if (country.length !== 2) {
      throw new ApiFault(400, "VALIDATION_ERROR", "country must be a two-letter country code", {
        country: "invalid",
      });
    }

    const customer = getCustomer(database, customerId);
    if (!customer) {
      throw new ApiFault(422, "UNKNOWN_CUSTOMER", `Address references unknown customer ${customerId}`);
    }
    if (customer.merged_into !== null) {
      throw new ApiFault(422, "UNKNOWN_CUSTOMER", "Addresses must reference an active customer");
    }
    const createdAt = new Date().toISOString();
    try {
      database
        .prepare(`
          INSERT INTO addresses (address_id, customer_id, street, postal_code, country, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(addressId, customerId, street, postalCode, country, createdAt);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new ApiFault(409, "DUPLICATE_ADDRESS_ID", `Address ${addressId} already exists`);
      }
      throw error;
    }

    const address = database
      .prepare("SELECT * FROM addresses WHERE address_id = ?")
      .get(addressId) as AddressRow;
    const result: AddressResponse = { address: toAddress(address) };
    response.status(201).json(result);
  }));

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (error instanceof ApiFault) {
      response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
      return;
    }
    next(error);
  });

  return router;
}
