-- A seller can delete an API at any stage. One that reached the Masumi registry or that buyers paid for keeps
-- its rows (receipts, escrow channels the gateway still settles), so it is retired and hidden instead.
alter table apis add column deleted_at timestamptz;
