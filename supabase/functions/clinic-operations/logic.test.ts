import assert from "node:assert/strict";
import test from "node:test";
import { phone, resolveService, resolveStaff, type Staff } from "./logic.ts";

const staff: Staff[] = [
  { id: "21111111-1111-4111-8111-111111111111", full_name: "Dr. Ahmed Qandil", specialty: "General Dentistry", services: ["Dental Cleaning", "Consultation", "Root Canal"], aliases: ["أحمد قنديل", "أحمد أنديل"] },
  { id: "21111111-1111-4111-8111-111111111112", full_name: "Dr. Mohammed Shuqeir", specialty: "Cosmetic Dentistry", services: ["Veneers Consultation", "Teeth Whitening"], aliases: [] },
  { id: "21111111-1111-4111-8111-111111111113", full_name: "Dr. Fatima Hassan", specialty: "Orthodontics", services: ["Orthodontic Consultation", "Braces Review"], aliases: [] },
  { id: "21111111-1111-4111-8111-111111111114", full_name: "Layla Salem", specialty: "Dental Hygiene", services: ["Dental Cleaning", "Preventive Care"], aliases: [] },
];

test("doctor aliases resolve to canonical staff", () => {
  for (const alias of ["Dr Ahmed", "Ahmed Kandil", "Ahmed Qandeel", "Dr Qandil", "دكتور أحمد قنديل", "د. أحمد قنديل", "احمد قنديل", "أحمد أنديل"]) {
    assert.equal(resolveStaff(staff, alias).practitioner?.id, staff[0].id, alias);
  }
  assert.equal(resolveStaff(staff, "محمد شقير").practitioner?.id, staff[1].id);
  assert.equal(resolveStaff(staff, "فاطمة حسن").practitioner?.id, staff[2].id);
  assert.equal(resolveStaff(staff, "ليلى سالم").practitioner?.id, staff[3].id);
});

test("unknown or ambiguous doctors do not resolve", () => {
  assert.equal(resolveStaff(staff, "Dr. Smith").status, "not_found");
  const duplicate = { ...staff[0], id: "other", full_name: "Dr. Ahmed Ali", aliases: [] };
  assert.equal(resolveStaff([...staff, duplicate], "Ahmed").status, "ambiguous");
});

test("services resolve without inferring from specialty", () => {
  assert.equal(resolveService(staff, "تنظيف الأسنان").service, "Dental Cleaning");
  assert.equal(resolveService(staff, "teeth whitening").service, "Teeth Whitening");
  assert.equal(resolveService(staff, "Consultation").service, "Consultation");
  assert.equal(resolveService(staff, "implant surgery").status, "not_found");
  const cleaning = resolveService(staff, "cleaning").service;
  assert.deepEqual(staff.filter(s => s.services.includes(cleaning!)).map(s => s.id), [staff[0].id, staff[3].id]);
  assert.equal(staff[1].services.includes("Dental Cleaning"), false);
});

test("Kuwaiti contact numbers normalize and malformed numbers fail", () => {
  assert.equal(phone("9912 3456"), "+96599123456");
  assert.equal(phone("+965-9912-3456"), "+96599123456");
  assert.equal(phone("9912345"), null);
  assert.equal(phone("991234567"), null);
  assert.equal(phone("123-abc-456"), null);
});
