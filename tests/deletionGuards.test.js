const {
  flagFromRow,
  isCategoryInUse,
  isPaymentTypeInUse,
  isBankAccountInUse,
  isPersonInUse,
  emiHasLinkedPayments,
} = require("../src/services/deletionGuards");

function mockClient(inUse) {
  return {
    query: jest.fn(async () => ({
      rows: [{ in_use: inUse }],
    })),
  };
}

describe("deletionGuards flag parsing", () => {
  test("treats postgres boolean shapes as true", () => {
    expect(flagFromRow({ in_use: true })).toBe(true);
    expect(flagFromRow({ in_use: "t" })).toBe(true);
    expect(flagFromRow({ in_use: "true" })).toBe(true);
    expect(flagFromRow({ in_use: 1 })).toBe(true);
    expect(flagFromRow({ in_use: false })).toBe(false);
    expect(flagFromRow({ in_use: 0 })).toBe(false);
  });
});

describe("deletionGuards SQL checks", () => {
  test("category looks at expenses, splits, and returns", async () => {
    const client = mockClient(true);
    await expect(isCategoryInUse("Home", client)).resolves.toBe(true);
    const sql = client.query.mock.calls[0][0];
    expect(sql).toContain("FROM expenses");
    expect(sql).toContain("FROM expense_category_splits");
    expect(sql).toContain("FROM expense_returns");
    expect(client.query.mock.calls[0][1]).toEqual(["Home"]);
  });

  test("payment type looks at payments.payment_type_id", async () => {
    const client = mockClient(false);
    await expect(isPaymentTypeInUse(9, client)).resolves.toBe(false);
    expect(client.query.mock.calls[0][0]).toContain("payment_type_id");
    expect(client.query.mock.calls[0][1]).toEqual([9]);
  });

  test("bank account looks at savings_transactions.bank_account_id", async () => {
    const client = mockClient(true);
    await expect(isBankAccountInUse(4, client)).resolves.toBe(true);
    expect(client.query.mock.calls[0][0]).toContain("bank_account_id");
  });

  test("person looks at debts.person_id", async () => {
    const client = mockClient(true);
    await expect(isPersonInUse(3, client)).resolves.toBe(true);
    expect(client.query.mock.calls[0][0]).toContain("person_id");
  });

  test("EMI linked payments look at payments.emi_product_id", async () => {
    const client = mockClient(true);
    await expect(emiHasLinkedPayments(12, client)).resolves.toBe(true);
    expect(client.query.mock.calls[0][0]).toContain("emi_product_id");
  });
});
