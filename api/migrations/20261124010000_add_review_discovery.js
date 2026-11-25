export async function up(db) {
  await db.schema.alterTable('links', (links) => links.text('attach_id'));
  await db.schema.createTable('review_starts', (starts) => {
    starts.text('repo').notNullable();
    starts.integer('number').notNullable();
    starts.text('status').notNullable();
    starts.integer('created').notNullable();
    starts.primary(['repo', 'number']);
  });
}

export async function down(db) {
  await db.schema.dropTable('review_starts');
  await db.schema.alterTable('links', (links) => links.dropColumn('attach_id'));
}
