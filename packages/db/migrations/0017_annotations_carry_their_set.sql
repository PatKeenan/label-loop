-- ADR-0079: an answer is given against a SET, so the row says which one.
--
-- NULLABLE, and it stays nullable. Annotation ran against a whole panel through M5 phase 6, so
-- those rows belong to no set and never will — backfilling them into an invented one would be a
-- claim nobody made, in an append-only table that could not be corrected afterwards. Every row
-- written from here carries it; the read that cares can tell the two eras apart by the NULL.
--
-- RESTRICT, as `panel_version_id` is: a set whose answers exist is a pass that happened, and it
-- cannot be deleted out from under them. The org cascade removes both together.
--
-- `sampler` is unchanged as a column and changes MEANING: it was the constant 'random' while the
-- queue itself was the sampler, and now carries the picker from the membership row that put the
-- trace in the set. Old rows keep 'random', which is what they were served by.
ALTER TABLE "annotations" ADD COLUMN "annotation_set_id" text;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_annotation_set_id_annotation_sets_id_fk" FOREIGN KEY ("annotation_set_id") REFERENCES "public"."annotation_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "annotations_set_annotator_idx" ON "annotations" USING btree ("annotation_set_id","annotator_id");