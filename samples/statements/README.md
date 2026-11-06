# Sample bank statements

Statement files for trying **File › Import…** by hand, and for screenshots. The banks, people and account numbers are
made up. Each file's closing balance is its opening balance plus its transactions, so the numbers add up everywhere.
The tests import every one of these files (`tests/plugins/import-ofx`, `tests/plugins/import`), so they keep working.

Every file is **plain ASCII**, so copying it between machines can't change it: the accented payee is written with
character references, which OFX allows. (An earlier copy held windows-1252 bytes, and lost its accents on the way to
another machine.) A test keeps them ASCII.

| File | What it is | What it shows |
|---|---|---|
| `maple-trust-chequing-2026-10.ofx` | OFX 1.02 (SGML), `CHARSET:1252`. Maple Trust Bank, chequing •••• 5678, CAD, October 2026: 17 transactions, closing at 4,677.80 | A cheque (#101), direct deposits, debit card purchases, an ATM withdrawal, a transfer out, a service charge and interest. An accented payee (*Café Dépôt*, written `CAF&#201; D&#201;P&#212;T`), and two identical coffees on one day |
| `maple-trust-chequing-2026-11.ofx` | The same account's next file: 26 October to 10 November, closing at 6,241.74 | Its first 5 transactions are the last 5 of October's file, with the same bank ids, so importing it after October adds only the 5 new ones |
| `northwind-visa-2026-10.qfx` | **QFX**: OFX 1.02 with Quicken's `<INTU.BID>`. Northwind Card Services, card •••• 3456 (masked in the file), October 2026: 8 transactions, owing 464.77 | A credit card: purchases negative, a payment and a refund positive, a foreign transaction fee. QFX files need nothing special: they are OFX |
| `harbour-bank-2026-10.ofx` | OFX 2.11 (XML), UTF-8. Harbour Bank: **chequing •••• 4410 and savings •••• 4411 in one file** | Two statements in one file, so the Account dialog asks twice (*Statement 1 of 2*, *Statement 2 of 2*). A transfer between them, and an `&` in a payee |

## A walkthrough

Start with `npm run dev`, and create an empty ledger (**File › New Ledger…**).

1. **File › Import…** and choose `maple-trust-chequing-2026-10.ofx`. The file dialog lists only `.ofx` and `.qfx`
   files, the types the installed OFX plugin reads.
2. **The Account dialog** asks which account the statement is for. The file names Maple Trust Bank, an account ending
   5678, chequing, CAD, and 17 transactions from Oct 1 to Oct 31, 2026. There are no accounts yet, so **Create a new
   account…** is chosen; the box to remember the account is ticked.
3. **Create…** opens the New Account form, filled in from the statement:
   - *Maple Trust Bank 5678*, chequing, CAD, at Maple Trust Bank, number 8812345678;
   - opened on 2026-10-01 with an opening balance of 1,000.00 (the bank's closing 4,677.80 less October's
     transactions).

   **Create**.
4. **The summary:** *17 transactions added to “Maple Trust Bank 5678”*. **Review in Register** shows them, all marked
   `E`:
   - payees tidied (*Costco Whse*, *Café Dépôt*, *Tim Hortons*, *Northern Lights Payroll*);
   - *Bank fees* on the monthly fee, and *Interest* on the interest;
   - the balance ends at **4,677.80**, as the bank's does.
5. **Import the same file again.** No dialog this time (the account was remembered). The summary says *Nothing new
   for “Maple Trust Bank 5678”: all 17 transactions were already imported*.
6. **Import `maple-trust-chequing-2026-11.ofx`.** No dialog. *5 transactions added, 5 already imported*: the week
   that overlaps October's file isn't doubled. The balance is now **6,241.74**.
7. **Delete a transaction** in the register, and import October's file again: it doesn't come back.
8. **Import `northwind-visa-2026-10.qfx`.** The Account dialog lists the chequing account, but it is a card
   statement, so choose **Create a new account…**. The form is filled in:
   - a credit card, *Northwind Card Services 3456*, number 3456 (the file shows only the last digits);
   - opened on 2026-10-02, the day before its first transaction, with an **amount owed of 540.00**.

   After the import the card owes **464.77**.
9. **Import `harbour-bank-2026-10.ofx`.** The dialog appears twice, once per account in the file. Create both, or
   choose **Skip This File** for one of them: the summary lists each statement.

To see an account found **by its number**, without the dialog, create an account first (any name) with the account
number `8812345678`, then import October's file.

## Matching and review

The import matches lines to transactions you entered yourself. This walkthrough enters six of October's transactions
by hand, the way people do: some before the bank posts them, one before the tip, one with a slip.

1. Start with an empty ledger. **Accounts › New Account…**: *Chequing*, type chequing, CAD, account number
   `8812345678`, opened 2026-09-01 with an opening balance of 1,000.00.
2. In its register, enter:

   | Date | Num | Payee | Payment | What the bank will say |
   |---|---|---|---|---|
   | Sep 28, 2026 | 101 | Landlord | 1,200.00 | *CHEQUE 101*, cleared Oct 2 |
   | Oct 3, 2026 | | The Keg | 50.00 | 57.50: you added the tip at the table |
   | Oct 5, 2026 | | Costco | 84.00 | 84.12, posted Oct 6 |
   | Oct 7, 2026 | | Hydro One | 80.00 | the same |
   | Oct 25, 2026 | | Amazon | 23.99 | *AMZN MKTP CA\*2K3L91*, posted Oct 27 |
   | Oct 29, 2026 | | Tim Hortons | 4.75 | two coffees that day; you entered one |

3. **File › Import…** `maple-trust-chequing-2026-10.ofx`. The account is found by its number, so no dialog. The
   summary: *11 transactions added to “Chequing”, 6 matched to ones already there (2 possible)*. **Review in
   Register**.
4. **The register.** The bar above it says *17 imported transactions to review (6 matches, 11 new)*. Every row to
   review has a bar at its left edge, the bank's version under it, and **Accept** and **Change…**:
   - *Costco*: **Matched to bank line:** **Oct 6** · POS PURCHASE COSTCO WHSE #0123 · **84.12**, with the date and
     amount that differ in bold;
   - *The Keg*: **Possible match** (in the warning colour), with **57.50** in bold;
   - *Landlord*: a possible match, its number tying it to *CHEQUE 101*;
   - *Hydro One*, *Amazon* and your coffee: matched;
   - the other 11, among them the second coffee: *New from the bank: …*.

   Nothing you entered has changed yet: a match is only proposed. **Next** (or `F8`) goes from one row to the next.
5. **Accept** on Costco: it moves to Oct 6, becomes 84.12, and is marked `E`. Your payee and category stay. The
   tooltip said so first.
6. **Change…** on The Keg, then *Unmatch: keep my transaction as it is, and add the bank line as a new one*. Your
   50.00 stays, and the bank's 57.50 is a row of its own.
7. Enter **Superstore**, 140.00, on Oct 14. Then **Change…** on the new *Loblaws* row (Oct 15, 142.87). Your
   Superstore is in the list, *1 day earlier · 2.87 less · payee*. Choose it, and keep *Remember that “LOBLAWS” is
   Superstore* ticked. The added row goes, and your entry takes the bank's date and amount. From now on the bank's
   *LOBLAWS* is your *Superstore*, in matching and for new lines.
8. **Delete** your Hydro One entry. Its bank line has lost its match: the bar says so, with **Resolve…**. Choose *Add
   the bank line as a new transaction*.
9. **Accept All…** asks first, saying how many matches change a date or an amount, then accepts the rest.
10. **Right-click** Costco: **Change Match…**, then *Unmatch: put my transaction back as it was (Oct 5, 2026, 84.00),
    and add the bank line as a new one*. Costco is back as you typed it, and the bank's 84.12 is a new row.
11. The register now holds your Keg (50.00) and Costco (84.00) beside the bank's. Delete those two: the balance is
    the bank's, **4,677.80**.

Importing the file again adds nothing: every line is known, including the ones you matched, unmatched or left out.


For import errors in the summary, import something that isn't a statement. Rename any text file to `.ofx`: the
summary says it *isn't an OFX statement*.
