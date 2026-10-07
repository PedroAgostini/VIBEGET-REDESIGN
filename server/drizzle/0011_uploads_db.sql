CREATE TABLE "uploaded_images" (
	"name" varchar(64) PRIMARY KEY NOT NULL,
	"content_type" varchar(32) NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
