// Display address cleanup: street names that Rentcast split across two lines.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { normalizeAddressKey } from "@/lib/address";
import { displayAddress } from "@/lib/displayAddress";

const austin = { city: "Austin", state: "TX", zipCode: "78746" };

describe("displayAddress", () => {
  test("structured fields: a street-name second line is joined with a space", () => {
    assert.equal(
      displayAddress({
        formattedAddress: "2004 Rue De St, Tropez, Austin, TX 78746",
        addressLine1: "2004 Rue De St",
        addressLine2: "Tropez",
        ...austin,
      }),
      "2004 Rue De St Tropez, Austin, TX 78746",
    );
    assert.equal(
      displayAddress({
        formattedAddress: "2305 Trail, of the Madrones, Austin, TX 78746",
        addressLine1: "2305 Trail",
        addressLine2: "of the Madrones",
        ...austin,
      }),
      "2305 Trail of the Madrones, Austin, TX 78746",
    );
  });

  test("formattedAddress only: the comma inside the street is removed", () => {
    assert.equal(displayAddress({ formattedAddress: "2004 Rue De St, Tropez, Austin, TX 78746" }), "2004 Rue De St Tropez, Austin, TX 78746");
    assert.equal(
      displayAddress({ formattedAddress: "2305 Trail, of the Madrones, Austin, TX 78746" }),
      "2305 Trail of the Madrones, Austin, TX 78746",
    );
    assert.equal(
      displayAddress({ formattedAddress: "2100 Rue De St, Germaine, Austin, TX 78746" }),
      "2100 Rue De St Germaine, Austin, TX 78746",
    );
  });

  test("a normal address is unchanged, structured or not", () => {
    const formattedAddress = "3901 Prentice Ln, Austin, TX 78746";
    assert.equal(displayAddress({ formattedAddress, addressLine1: "3901 Prentice Ln", ...austin }), formattedAddress);
    assert.equal(displayAddress({ formattedAddress }), formattedAddress);
    assert.equal(
      displayAddress({ formattedAddress: "500 Laurel Valley Rd, West Lake Hills, TX 78746" }),
      "500 Laurel Valley Rd, West Lake Hills, TX 78746",
    );
  });

  test("a unit keeps its comma", () => {
    assert.equal(
      displayAddress({ addressLine1: "935 La Posada Dr", addressLine2: "Ste 212", city: "Austin", state: "TX", zipCode: "78752" }),
      "935 La Posada Dr, Ste 212, Austin, TX 78752",
    );
    assert.equal(displayAddress({ formattedAddress: "10 Elm St, Apt 4, Austin, TX 78701" }), "10 Elm St, Apt 4, Austin, TX 78701");
    assert.equal(displayAddress({ formattedAddress: "10 Elm St, #4, Austin, TX 78701" }), "10 Elm St, #4, Austin, TX 78701");
    // "Stephens" starts like "Ste" but is a street name, not a unit.
    assert.equal(displayAddress({ formattedAddress: "1 Main, Stephens Way, Austin, TX 78701" }), "1 Main Stephens Way, Austin, TX 78701");
  });

  test("missing structured fields fall back to formattedAddress", () => {
    // line 1 present but no zip: not enough to rebuild
    assert.equal(
      displayAddress({ formattedAddress: "2305 Trail, of the Madrones, Austin, TX 78746", addressLine1: "2305 Trail", city: "Austin", state: "TX" }),
      "2305 Trail of the Madrones, Austin, TX 78746",
    );
    // no recognizable city, state, zip tail: returned as is
    assert.equal(displayAddress({ formattedAddress: "Somewhere, Unknown" }), "Somewhere, Unknown");
    assert.equal(displayAddress({}), "");
  });

  test("extra whitespace is collapsed", () => {
    assert.equal(
      displayAddress({ formattedAddress: "  2305 Trail ,  of the  Madrones,Austin,  TX   78746 " }),
      "2305 Trail of the Madrones, Austin, TX 78746",
    );
    assert.equal(
      displayAddress({ addressLine1: " 2004  Rue De St ", addressLine2: "  Tropez ", city: " Austin", state: "TX ", zipCode: " 78746" }),
      "2004 Rue De St Tropez, Austin, TX 78746",
    );
  });

  test("the cache key for a typed address is unaffected", () => {
    // normalizeAddressKey treats commas as word breaks, as before this change.
    assert.equal(normalizeAddressKey("2305 Trail, of the Madrones, Austin, TX 78746"), "2305 trail of the madrones austin tx 78746");
  });
});
