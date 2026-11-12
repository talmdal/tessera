# Sample bank statements

Statement files for trying **File › Import…** by hand, and for screenshots. The banks, people and account numbers are
made up. Each file's closing balance is its opening balance plus its transactions, so the numbers add up everywhere.
The tests import every one of these files (`tests/plugins/import-ofx`, `tests/plugins/import-csv`,
`tests/plugins/import-qif`, `tests/plugins/import`), so they keep working.

Every file is **plain ASCII**, so copying it between machines can't change it: the accented payee is written with
character references, which OFX allows. (An earlier copy held windows-1252 bytes, and lost its accents on the way to
another machine.) A test keeps them ASCII.

| File | What it is | What it shows |
|---|---|---|
| `maple-trust-chequing-2026-10.ofx` | OFX 1.02 (SGML), `CHARSET:1252`. Maple Trust Bank, chequing •••• 5678, CAD, October 2026: 17 transactions, closing at 4,677.80 | A cheque (#101), direct deposits, debit card purchases, an ATM withdrawal, a transfer out, a service charge and interest. An accented payee (*Café Dépôt*, written `CAF&#201; D&#201;P&#212;T`), and two identical coffees on one day |
| `maple-trust-chequing-2026-11.ofx` | The same account's next file: 26 October to 10 November, closing at 6,241.74 | Its first 5 transactions are the last 5 of October's file, with the same bank ids, so importing it after October adds only the 5 new ones |
| `northwind-visa-2026-10.qfx` | **QFX**: OFX 1.02 with Quicken's `<INTU.BID>`. Northwind Card Services, card •••• 3456 (masked in the file), October 2026: 8 transactions, owing 464.77 | A credit card: purchases negative, a payment and a refund positive, a foreign transaction fee. QFX files need nothing special: they are OFX |
| `cedar-savings-2026-09.ofx`, `cedar-savings-2026-10.ofx` | OFX 1.02 (SGML). Cedar Credit Union, savings •••• 3301, CAD, September and October 2026: 5 transactions each, closing at 2,799.85 and 3,449.95 | A bank that **restarts its transaction ids every month**: both files use `CC-001` to `CC-005` for different transactions. See [Ids a bank used before](#ids-a-bank-used-before) |
| `lakeside-business-2026-10.qbo`, `lakeside-business-2026-11.qbo` | **QBO** (QuickBooks Web Connect): OFX 1.02 with Intuit's `<INTU.BID>` and `<INTU.USERID>`. Lakeside Credit Union, business chequing •••• 0117, CAD: October (10 transactions, closing at 11,038.25), then 26 October to 30 November (10 transactions, closing at 4,764.15) | QBO files need nothing special either: they are OFX. November's file repeats October's last three transactions with the same ids, so they aren't doubled. See [QuickBooks files](#quickbooks-files-qbo) |
| `maple-trust-chequing-2026-10-converted.qbo` | QBO. The October Maple Trust statement **as a conversion tool might write it**: the same transactions, with ids numbered 1 to 17 and another bank's `INTU.BID` | Ids a tool made up are recognised, so the lines are known by their content. See [Ids a conversion tool made up](#ids-a-conversion-tool-made-up) |
| `northwind-visa-2026-10-16-converted.qbo` | QBO, **a mid-month download of the Northwind card**, as a conversion tool might make it from the card website's export: 1 to 16 October, 5 transactions with ids 1 to 5, owing 397.16. Two are still **pending**: *PENDING - CANADIAN TIRE #0385* on Oct 10 and *PENDING - SQ \*BYTOWN COFFEE* on Oct 16 | Imported before `northwind-visa-2026-10.qfx`, it shows the same transactions recognised from another kind of file, pending ones included once posted (the QFX has them on Oct 11 and 19, under the merchant's own text). See [The same transactions from another file](#the-same-transactions-from-another-file) |
| `northwind-visa-2026-10-reversed.qfx` | The October card statement **the wrong way round**, as a bank writing amounts from its own side might: charges positive, payments negative, and the balance positive (464.77). Same card, same ids | Tessera asks *Amounts Reversed?* before importing it. See [Amounts the wrong way round](#amounts-the-wrong-way-round) |
| `northwind-visa-2026-11.qfx` | The card's November statement, the right way round: 1 to 30 November, 5 transactions (a payment of October's 464.77 among them), owing 163.26 | After the reversed October: the bank has fixed its files, and the correction kept for them comes off |
| `maple-trust-chequing-2026-11-reversed.ofx` | November's chequing statement **the wrong way round**, balance and all | After October's file, the bank's balance and October's own lines say it is reversed |
| `harbour-bank-2026-10.ofx` | OFX 2.11 (XML), UTF-8. Harbour Bank: **chequing •••• 4410 and savings •••• 4411 in one file** | Two statements in one file, so the Account dialog asks twice (*Statement 1 of 2*, *Statement 2 of 2*). A transfer between them, and an `&` in a payee |
| `maple-trust-chequing-2026-10.csv` | **CSV**. The October Maple Trust statement as the bank's CSV export: a header, *Withdrawals* and *Deposits* columns, a running *Balance*, month-first dates (`10/02/2026`), and a *Status* column. 17 posted transactions closing at 4,677.80, and one **pending** (the Costco of Nov 1) | A CSV file's columns shown for checking, recognised from its header. The pending row is left out. See [CSV files](#csv-files) |
| `maple-trust-chequing-2026-11.csv` | The next CSV export: 27 October to 8 November, 10 transactions closing at 6,241.74, the Costco now posted on Nov 2 | The same columns, remembered; the overlapping week isn't doubled |
| `maple-trust-cheques-2026-10-fr.csv` | CSV **in French**: an account and period line before the header, `;` between columns, day-first dates (`14/10/2026`), comma decimals with spaces between thousands (`1 250,00`). 8 transactions closing at 4,717.71 | The preamble skipped, and the French columns, dates and decimals recognised |
| `northwind-visa-2026-10.csv` | The Northwind card's October as a **headerless** CSV: date, description, amount, with **charges positive** and payments negative | The columns worked out from what they hold, and the amounts guessed reversed, saying why |
| `harbour-bank-2026-10.csv` | CSV with an **Account Number** column: Harbour Bank's chequing and savings in one file, each with its running balance | One statement per account, each found by its number |
| `maple-trust-chequing-2026-09.qif` | **QIF** as Microsoft Money exports one account: `!Type:Bank`, an *Opening Balance* record naming the account (`L[Maple Trust Chequing]`, 720.73 on Aug 31), then September and the first week of October: 17 transactions closing at 2,658.38. Dates with Quicken's apostrophe years (`9/ 2'26`), categories, a split, cheques 100 and 101, an ATM withdrawal and a transfer | Bringing an account's history over from Money: the account made from the file, its categories, and the bank's October OFX after it. See [Bringing accounts over from Money or Quicken](#bringing-accounts-over-from-money-or-quicken) |
| `household-quicken-export.qif` | QIF as **Quicken exports a whole file**: its account list (AutoSwitch), category and class lists, then *Everyday Chequing*, *High Interest Savings* and *Northwind Visa*, each with an opening balance, and an *RRSP* investment account; transfers between them, a split, a class | A statement per account, each asked about (*Statement 1 of 3*…); the RRSP left out with a warning |
| `northwind-visa-2026-09.qif` | A card's QIF **as a bank writes it**: `!Type:CCard`, no account name, charges positive and the payment negative; September, 8 transactions | The sign check catches it (*Amounts Reversed?*), and the answer is kept for the bank's files |
| `cedar-savings-2026-08-12.qif` | A bank's QIF downloaded mid-month, dates **day first** (`05/08/2026`) and every day 12 or less: 4 transactions, Aug 1 to 12 | The file can be read two ways, so **QIF Options** asks, offering Day/Month/Year first (Aug 1 to 12, not January to December) |

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

## Ids a bank used before

Some sources reuse their transaction ids: a bank that numbers each statement's lines from 1, or a tool that converts
PDF statements. The Cedar Credit Union files do: September's `CC-001` is a transfer on Sep 1, and October's `CC-001` is
a transfer on Oct 1.

1. **File › Import…** `cedar-savings-2026-09.ofx`, and **Create a new account…** from it. *5 transactions added.*
2. **File › Import…** `cedar-savings-2026-10.ofx`. No dialog (the account is remembered). The summary says:

   *5 transactions added to “Cedar Credit Union 3301”, 5 recognised by their content, as the bank had used their
   ids before for other transactions.*

   with the warning *5 of the bank’s ids in this statement had been used before for other transactions, so none of its
   ids are trusted: its lines are recognised by their content instead.* The balance is **3,449.95**, as the bank's.
3. **Import October's file again.** Nothing is added: its lines are known by their content now.

Before this was handled, step 2 said *Nothing new: all 5 transactions were already imported*, and October's five
transactions were lost. A line whose id was used before is taken as a different transaction when its date is more than
3 days from the earlier one's, or when both its amount and its payee differ. Otherwise it is the same line sent again
(a corrected amount, or a new description), and it is a duplicate, as before. See
[import-formats-design.md](../../docs/import-formats-design.md#bank-ids-that-collide).

## QuickBooks files (QBO)

1. **File › Import…**: the file dialog lists `.qbo` files too. Choose `lakeside-business-2026-10.qbo`, and **Create a
   new account…**: *Lakeside Credit Union 0117*, chequing, opened on 2026-09-30 with 12,500.00. *10 transactions
   added.*
2. **Import `lakeside-business-2026-11.qbo`.** No dialog. *7 transactions added, 3 already imported.* The balance is
   **4,764.15**, as the bank's.

A QBO file and an OFX file for the same account are the same account to Tessera: the saved account match and the
bank's ids carry over from one to the other.

## Ids a conversion tool made up

QuickBooks accepts only QBO files, so tools that turn a PDF or CSV statement into QBO are common, and some number each
file's transactions 1, 2, 3…. Those ids mean nothing from one file to the next.

1. In a new ledger, **File › Import…** `maple-trust-chequing-2026-10-converted.qbo`, and **Create a new account…**.
   *17 transactions added*, with the warning *Maple Trust Bank •••• 5678: the transaction ids look made up (1, 2,
   3…), so its lines are recognised by their content instead.*
2. **Import it again.** Nothing is added: the lines are known by their content.

The two files know the same transactions by different ids, so importing one after the other for the same account is
what [The same transactions from another file](#the-same-transactions-from-another-file) shows.

## The same transactions from another file

A bank's CSV export knows a transaction by its content, its OFX by the bank's id, so the same transaction from the two
kinds of file isn't recognised by its id. Tessera compares a new line with the lines imported before from other files:
the same amount, dates at most 3 days apart, the bank's text alike. Such a line is proposed as **Already imported?**
on the transaction it looks like, and **nothing is added** for it until you say so. Below, the converted QBO samples play
the part of the other kind of file: their ids are made up, so they too are known by their content. The
[CSV files](#csv-files) section does the same with the CSV samples.

**A chequing account, month to month.**

1. In a new ledger, **File › Import…** `maple-trust-chequing-2026-10-converted.qbo`, and **Create a new account…**.
   *17 transactions added*, with the warning that the ids look made up.
2. **Review in Register**, and **Accept All…** (*Accept 17 new transactions?*). To see it as it usually is, with last
   month reconciled by the time next month's file comes, **Reconcile…** on Oct 31 to an ending balance of
   **4,677.80**, tick every row, and **Complete**.
3. **File › Import…** `maple-trust-chequing-2026-11.ofx`. No dialog: the account is remembered. The summary says
   *5 transactions added to “Maple Trust Bank 5678”, 5 looked like transactions imported before from another file and
   weren't added: check them in the register.* The balance is **6,241.74**, as the bank's: nothing was counted twice.
4. **Review in Register.** The bar says *10 imported transactions to review (5 new, 5 possibly already imported), from
   maple-trust-chequing-2026-11.ofx*. October's last five rows (Amazon, the two coffees, the fee and the interest)
   are marked in the warning colour, reconciled or not:

   *Already imported? Oct 27 · AMZN MKTP CA\*2K3L91 · 23.99 in maple-trust-chequing-2026-11.ofx looks like this one,
   from maple-trust-chequing-2026-10-converted.qbo*

   The two identical coffees pair with the two coffees, one each.
5. **Accept** one: it is the same transaction, nothing in the account changes, and the mark goes.
6. **Change…** on another: the dialog starts on the transaction it looks like (*already imported*). Choose **It's a
   different transaction: add the bank line as a new one**: it is added, and the balance moves by its amount. To undo
   that, **Change…** on the new row and **Don't import this bank line**.
7. **Accept All…** the rest: *Accept 5 new transactions and 3 lines already imported? The 3 lines already imported from
   another file won't be added again.*
8. **Import November's file again.** *Nothing new: all 10 transactions were already imported.*

**A card's pending lines, once posted.**

1. **File › Import…** `northwind-visa-2026-10-16-converted.qbo`, and **Create a new account…**: a credit card, owing
   540.00 before October. *5 transactions added*, two of them still pending (Canadian Tire on Oct 10, the coffee on
   Oct 16). Their payees are named without the card's *PENDING*.
2. **File › Import…** `northwind-visa-2026-10.qfx`, the month's statement. *3 transactions added, 5 looked like
   transactions imported before from another file…* The card owes **464.77**, as the statement says.
3. In the register, the five from mid-month are marked *Already imported?*, the pending ones too: *Oct 11 · CANADIAN
   TIRE #0385 · 214.67*, with the date emphasised, as the card posted it a day after the pending one, and *Oct 19 · SQ
   \*BYTOWN COFFEE · 17.25*, three days after. **Accept** keeps your transaction as it is, with its pending date; edit
   the date if you'd rather have the posting date.

Two files from the same bank with its own ids are never compared this way: two different ids from one bank are two
transactions. That is why October's and November's OFX files overlap by their ids, as before.

## Amounts the wrong way round

A format reads amounts as the file writes them, and some banks write them from their own side: a card's charges as
positive, say. Once Tessera knows the account, it checks. Each of these can point to reversed amounts:
- reversed, the lines match transactions you entered, or look like lines imported before, and as they are they don't;
- reversed, they bring the account to the bank's balance;
- on a source's first file into the account, most of the lines run the way that account rarely goes (payments on a card,
  deposits in a chequing account);
- on a later file, it runs the other way from the source's earlier files.

Only then does it ask **Amounts Reversed?**. A statement the right way round, or a savings account that is mostly
deposits (the Cedar Credit Union files), is imported without a question. The tests go through each case below
(`tests/plugins/import/signs.test.ts`).

**A card statement written from the bank's side.**

1. In a new ledger, **File › Import…** `northwind-visa-2026-10-reversed.qfx`, **Create a new account…**, and **Create**.
2. **Amounts Reversed?** asks: *The amounts in northwind-visa-2026-10-reversed.qfx may be the wrong way round for
   “Northwind Card Services 3456” (credit card): 6 of its 8 lines would lower what you owe, and only 2 would add to
   it.* A table shows two lines both ways, in the card's own terms: the payment as a *Charge 540.00* as they are, a
   *Payment* reversed. **Reverse the amounts** is chosen, and *Remember for files like this one* is ticked:
   **Continue**.
3. The summary: *8 transactions added… Amounts reversed, as you chose; files like this one will be too.* The card owes
   **464.77**, and opened owing 540.00: an account made from the statement is put right too.
4. **Import the reversed file again.** No question: *Nothing new… Amounts reversed, as you chose for files like this
   one.* Tessera keeps the correction itself, as OFX files can't say how to read them.
5. **The bank fixes its files:** import `northwind-visa-2026-11.qfx`, written the right way round. The kept correction
   now turns it the wrong way, so Tessera asks again, saying *These amounts are shown reversed already…*, with
   *Reversed, they bring the account to the bank's balance on Nov 30, 2026 (you owe 163.26)* and *Files from this source
   have been 75% money out; this one is 20%.* **Reverse the amounts** reads them as the file writes them, and takes the
   correction off. The card owes **163.26**.

**With charges typed in.** In a new ledger, **Accounts › New Account…**: *Visa*, a credit card, opened Sep 30, 2026
owing 540.00. In its register, type three charges: Oct 1 *Air Canada* 128.44, Oct 5 *Netflix* 36.80, Oct 10 *Canadian
Tire* 214.67. Import `northwind-visa-2026-10-reversed.qfx` and choose *Visa*. The question adds *Reversed, 3 lines
match transactions you entered; as they are, none do.* **Reverse**: the three are proposed as matches, five lines are
added, and Visa owes **464.77**.

**A chequing account, a month later.** In a new ledger, import `maple-trust-chequing-2026-10.ofx` into a new account,
then `maple-trust-chequing-2026-11-reversed.ofx`. The question: *Reversed, they bring the account to the bank's balance
on Nov 10, 2026 (6,241.74); as they are, they don't* and *Files from this source have been 82% money out; this one is
20%.* **Reverse**: *5 transactions added, 5 already imported*, and the balance is **6,241.74**.

*Import them as they are* imports the file as written, and *Cancel Import* stops the import. Unticking *Remember*
reverses this file only, and the next one like it is asked about again.

## CSV files

Most banks offer a CSV export beside OFX, or instead of it. A CSV file says what its columns are only by their names,
and some banks leave even those out, so Tessera shows **every** CSV file's columns in **CSV Columns** before importing
it: guessed the first time, remembered after. Under the columns, the preview is what will be imported, made by the
same code that imports it.

**Two months of a chequing account.**

1. In a new ledger, **File › Import…** `maple-trust-chequing-2026-10.csv`. CSV Columns says *Tessera recognised these
   columns. Check the preview, then Import: they'll be remembered for files like this.* Over the columns: *Date*,
   *Payee*, *Money out*, *Money in*, *Balance* and *Status*, with **Dates** *Month/Day/Year*. The preview ends *17 lines
   · Oct 2 – 31, 2026 · closing balance 4,677.80*, and *1 row left out ▸* shows *Row 19: It is pending: it will come
   with a later export, once the bank posts it.* **Import**.
2. The Account dialog shows what the file says: only its columns. **Create a new account…**. A CSV file doesn't say
   the account's name or type: name it *Chequing*, and choose **Chequing**. The opening balance is filled in (1,000.00),
   worked out from the file's balance. **Create**. *17 transactions added to “Chequing”*, with *1 pending transaction
   was left out; it'll come with a later export, once the bank posts it.*
3. **File › Import…** `maple-trust-chequing-2026-11.csv`. *Same columns as last time (files like this one, last
   imported …)*, with **Import** ready: press **Enter**. A CSV file can't name its account, so the Account dialog asks
   again, with *Chequing* chosen (*Used last time*): **Enter** again. (Tick *Don't ask again for files like this one*
   to stop it asking.) *5 transactions added to “Chequing”, 5 already imported.* The balance is **6,241.74**, and
   October's pending Costco is there, posted on Nov 2.

**A CSV export, then the bank's OFX.** Instead of step 3, import `maple-trust-chequing-2026-11.ofx` and choose
*Chequing*. The OFX file knows its transactions by the bank's ids, the CSV file by their content: *5 transactions added
to “Chequing”, 5 looked like transactions imported before from another file and weren't added: check them in the
register.* The balance is **6,241.74**.

**In French.** In a new ledger, import `maple-trust-cheques-2026-10-fr.csv`. *Tessera recognised these columns*:
**Start at** the header on row 4 (the account and period lines above it are skipped), **Separator** *Semicolon*,
**Dates** *Day/Month/Year*, **Decimal** *1.234,56*. The preview: *8 lines · Oct 2 – 31, 2026 · closing balance
4,717.71*. Create a new account: *8 transactions added*, and the balance is **4,717.71**.

**A card's export, without a header, charges positive.**

1. In a new ledger, import `northwind-visa-2026-10.csv`. *Tessera guessed these columns. Check the highlighted ones and
   the preview…*: *Date*, *Payee* and *Amount*, worked out from what the columns hold, and **Money out is shown as
   positive (amounts are reversed)** ticked, because *6 of the 8 amounts are positive. Most lines in an account are money
   out, so money out is probably shown as positive here.* The preview shows *AIR CANADA 0142325781* as *−128.44*.
   **Import**.
2. **Create a new account…**: name it *Northwind Visa*, a **Credit card**, owing **540.00** before October (the file
   has no balance to work it out from). *8 transactions added*, and the card owes **464.77**.

To see the sign check catch it instead, untick *Money out is shown as positive* in step 1. After the account is made,
**Amounts Reversed?** asks (*6 of its 8 lines would lower what you owe, and only 2 would add to it*): **Reverse the
amounts**, with *Remember* ticked. The card owes **464.77** all the same, and the CSV format keeps the answer in the
layout: import the file again, and CSV Columns shows the box ticked, with nothing else asked.

**Two accounts in one file.** In a new ledger, import `harbour-bank-2026-10.ofx` and create both accounts. Then import
`harbour-bank-2026-10.csv`: after CSV Columns, no Account dialog, as each statement's account is found by its number.
The OFX file had the same transactions: *Nothing added to “Harbour Bank 4410”, 5 looked like transactions imported
before from another file…*, and 2 for the savings account.

**A CSV export named `.txt`.** Copy `northwind-visa-2026-10.csv` to `export.txt`. **File › Import…** doesn't list it
under *All supported statements*: choose **All files**, and it is read as CSV.

Your own bank's CSV exports can be added to the tests once anonymised: see
[tests/fixtures/import/real](../../tests/fixtures/import/real/README.md).

## Bringing accounts over from Money or Quicken

Microsoft Money and Quicken both export accounts as **QIF** files. In Money, choose **loose** QIF when it asks:
**strict** cuts every account and category name to 15 characters. Importing one brings the account's history into
Tessera: its transactions with their payees, memos and cheque numbers, its opening balance, and its categories where
your ledger has the same ones. Transfers come in as ordinary lines in each account, a split as its total with its parts
in the memo, and investment accounts are left out.

**One account from Money.**

1. In a new ledger, **File › Import…** `maple-trust-chequing-2026-09.qif`. No question about the file: its dates and
   amounts read only one way.
2. The Account dialog shows what the file says: *Maple Trust Chequing*, chequing. **Create a new account…**: the New
   Account form is filled in from the file, *Maple Trust Chequing*, opened on Sep 1, 2026 with **720.73**, the file's
   opening balance. **Create**.
3. **Categories from the File** asks, once for this source: *maple-trust-chequing-2026-09.qif gives a category for 14
   new transactions, and your ledger has them*, with a table of examples (*Landlord*, where the file says *Housing :
   Rent*; *Northern Lights Payroll*, *Salary*…). A new ledger's starter categories have every one of them. Choose **The file's categories**, and
   **Continue**.
4. *17 transactions added to “Maple Trust Chequing”*, and *14 new transactions took their categories from the file, as
   you chose for “Maple Trust Chequing”.* The balance is **2,658.38**. Costco's Sep 5 row, a split in Money, has the
   memo *Weekly shop · Split: Food:Groceries 64.12 · Household 20.00*, and no category.

**Then the bank's own file.** The Money file runs into October's first week. **File › Import…**
`maple-trust-chequing-2026-10.ofx` and choose *Maple Trust Chequing*. The first four of October's lines are already
there, from Money: *13 transactions added to “Maple Trust Chequing”, 4 looked like transactions imported before from
another file and weren't added: check them in the register.* Money named the cheque's payee *Landlord* where the bank
writes *CHEQUE 101*; the two are paired by the cheque's number. The balance is **4,677.80**, as the bank's.

**A whole Quicken file.** In a new ledger, import `household-quicken-export.qif`. The Account dialog asks for each
account in turn (*Statement 1 of 3*, *2 of 3*, *3 of 3*): **Create a new account…** each time; the savings account is
made as a savings account, and the card as a credit card. The summary: *10 transactions added to “Everyday Chequing”*,
*2… “High Interest Savings”*, *5… “Northwind Visa”*, with *An investment account (“RRSP”) was left out: Tessera doesn't
import investment transactions yet.* The balances are **2,539.45**, **8,504.12**, and **357.82** owed.

**A bank's card file, the wrong way round.** In a new ledger, import `northwind-visa-2026-09.qif`, and **Create a new
account…**: *Northwind Visa*, a credit card (the file says so), owing **450.00** before September. **Amounts
Reversed?** asks: *7 of its 8 lines would lower what you owe, and only 1 would add to it.* **Reverse the amounts**, with
*Remember* ticked: *Amounts reversed, as you chose; files like this one will be too.* The card owes **361.81**. The
answer is kept with the QIF files' settings for this bank's files, so the next one is read the right way round without
a question.

**A file whose dates read two ways.** Import `cedar-savings-2026-08-12.qif`. Every day in it is 12 or less, so
**QIF Options** asks: *Dates: every day in the file is 12 or less, so “01/08/2026” could be either*, with
*Day/Month/Year: 01/08/2026 is Aug 1, 2026* chosen, as its dates then span twelve days rather than a year. **OK**.
Import it again: nothing is asked, as the answer is remembered for the bank's files.

Your own Money and Quicken exports can be added to the tests once anonymised: see
[tests/fixtures/import/real](../../tests/fixtures/import/real/README.md).

## What imports remember

After any of the walkthroughs above, **File › Saved Import Choices…** shows everything the imports remembered, for this
ledger, in three tabs:
- **Accounts**: which account each source's statements go to (*Northwind Card Services •••• 3456* → the card), and
  whether to ask every time. Point one at another account, or *Forget* it: the next file from that source asks.
- **Payees**: payee names learnt from the bank's text, as matches were accepted.
- **Files and choices**, by source: a CSV file's columns (*Date, Description, Withdrawals, Deposits, Balance, Status ·
  Dates month first*), a QIF source's options (*Dates day first*), whether its categories are used, amounts read the
  other way round, and how a source's amounts usually run (for the sign check).

*Forget* one, and it is asked about, or worked out again, with the next file it applies to: forget the October CSV's
columns, and November's CSV Columns says *Tessera recognised these columns* instead of *Same columns as last time*.
Change a category choice in its menu, and the next file from that source uses the new answer.

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
