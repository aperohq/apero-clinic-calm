# Launch basics: owner checks

The dashboard sends password reset emails through Supabase Auth and redirects the reset link to `<current Apero origin>/reset-password`.

Before using the production domain, add its exact `/reset-password` URL to the Supabase Auth redirect allow list and confirm the Auth site URL points to the intended Apero domain. Check that the production email sender/template is configured and deliverable, then test a reset with a real clinic account. These settings are managed in Supabase and are not changed by this repository.

The public Privacy Policy and Terms of Service routes are launch drafts. Before treating them as final legal documents, confirm the Apero legal entity and address, applicable jurisdiction, privacy notices and consent for call handling, processing locations, retention and deletion practices, commercial terms, support commitments, termination process, and warranties or liability terms with the owner and legal counsel.
