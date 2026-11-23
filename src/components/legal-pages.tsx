import { Link } from "@tanstack/react-router";
import { AperoMark } from "@/components/apero-brand";
import { Panel } from "@/components/page-ui";

function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <Link to="/home" aria-label="Apero home">
            <AperoMark />
          </Link>
          <nav className="flex gap-4 text-sm text-muted-foreground">
            <Link to="/privacy" className="hover:text-foreground">
              Privacy
            </Link>
            <Link to="/terms" className="hover:text-foreground">
              Terms
            </Link>
            <Link to="/login" className="hover:text-foreground">
              Sign in
            </Link>
          </nav>
        </header>
        <Panel className="space-y-6 p-6 sm:p-9">
          <div>
            <h1 className="text-2xl font-semibold sm:text-3xl">{title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Launch draft · For owner and legal review
            </p>
          </div>
          <div className="space-y-6 text-sm leading-7 text-muted-foreground [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground [&_a]:font-medium [&_a]:text-foreground [&_a]:underline">
            {children}
          </div>
        </Panel>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Questions?{" "}
          <a href="mailto:apero.hq@gmail.com" className="underline">
            apero.hq@gmail.com
          </a>
        </p>
      </div>
    </main>
  );
}

export function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <section>
        <h2>What Apero handles</h2>
        <p>
          Apero provides a clinic reception and operations workspace. Account information may
          include a user’s name, email address, phone number, role, and clinic association. Clinic
          operational data may include staff schedules, services, appointments, and client records.
          Calls handled through the service may produce caller details, recordings, transcripts,
          summaries, and booking outcomes when those features are enabled.
        </p>
      </section>
      <section>
        <h2>How information is used</h2>
        <p>
          We use this information to provide clinic access, display and manage operations, handle
          calls and bookings, troubleshoot problems, and respond to support requests. Clinic users
          should only enter information needed for their work and follow their clinic’s own privacy
          obligations.
        </p>
      </section>
      <section>
        <h2>Service providers</h2>
        <p>
          Apero uses service providers to operate the product, including Supabase for application
          data and authentication and Retell for voice call handling. These providers may process
          information needed to deliver the relevant service. Clinics should review their own
          arrangements and notices for callers and patients.
        </p>
      </section>
      <section>
        <h2>Google Calendar connections</h2>
        <p>
          When an authorized clinic owner connects Google Calendar, Apero uses the selected
          calendar’s identifier, event identifiers, event times, and timezone information to account
          for busy periods and synchronize appointments. Calendar names are shown during selection.
          Google grants calendar permissions for the account; Apero uses the calendar explicitly
          selected for that clinic and practitioner.
        </p>
        <p>
          Apero sends Google a generic “Reserved appointment” event with its start and end times.
          Patient names, telephone numbers, appointment notes, and invitations are not included.
          Appointment changes are managed in Apero; external calendar events affect availability,
          and conflicting changes are surfaced for review.
        </p>
        <p>
          Access and refresh credentials are encrypted on the server and used for the scheduling
          connection. Calendar availability metadata is stored with the clinic’s access controls.
          Google Calendar data is not used for advertising or general-purpose AI model training.
          Google and Apero’s application-hosting and data providers process information as needed to
          deliver synchronization.
        </p>
        <p>
          Disconnecting in Apero removes stored connection credentials and cached busy intervals and
          stops new synchronization. Existing Google events remain for the calendar owner to review.
          You can also remove Apero’s grant in{" "}
          <a href="https://myaccount.google.com/connections">Google account connections</a>.
          Restricted audit records and encrypted backups may remain according to applicable
          retention, legal-hold, and recovery policies. For access, deletion, or connection
          questions, contact <a href="mailto:apero.hq@gmail.com">apero.hq@gmail.com</a>.
        </p>
        <p>
          Apero’s use and transfer of information received from Google APIs must adhere to the{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy">
            Google API Services User Data Policy
          </a>
          , including Limited Use requirements.
        </p>
      </section>
      <section>
        <h2>Access and security</h2>
        <p>
          Account access requires authentication. Clinic data is intended to be limited to
          authorized users of that clinic according to their role. No online service can promise
          absolute security. Please contact us promptly if you suspect unauthorized access.
        </p>
      </section>
      <section>
        <h2>Requests and contact</h2>
        <p>
          For questions about information in Apero, access, or correction requests, contact{" "}
          <a href="mailto:apero.hq@gmail.com">apero.hq@gmail.com</a>. The clinic may also need to
          handle requests concerning its patient and caller records.
        </p>
      </section>
      <section>
        <h2>Owner review before launch</h2>
        <p>
          Confirm the legal entity and contact address, applicable jurisdiction, the clinic’s role
          in privacy notices and consent, any international processing, and retention and deletion
          practices before publishing this draft as final policy.
        </p>
      </section>
    </LegalPage>
  );
}

export function TermsPage() {
  return (
    <LegalPage title="Terms of Service">
      <section>
        <h2>The service</h2>
        <p>
          Apero is software for clinic reception and operations, including call information,
          appointments, client records, and staff scheduling. Features and availability may change
          as the service develops.
        </p>
      </section>
      <section>
        <h2>Clinic responsibilities</h2>
        <p>
          Clinics are responsible for their own clinical and medical decisions, patient
          communications, record accuracy, and compliance with obligations that apply to their work.
          Apero does not make clinical decisions or replace qualified clinic staff.
        </p>
      </section>
      <section>
        <h2>Accounts and acceptable use</h2>
        <p>
          Users should protect their login details, use only accounts they are authorized to access,
          and keep account information accurate. Do not use the service to access another clinic’s
          data, disrupt the service, or submit unlawful or harmful content. Clinics should manage
          access for their team and tell Apero when an account should be disabled.
        </p>
      </section>
      <section>
        <h2>Third-party services</h2>
        <p>
          The service relies on providers such as Supabase and Retell. Their availability may affect
          parts of Apero, including sign-in, data access, and calls. Apero may suspend access when
          needed for security, maintenance, or misuse.
        </p>
      </section>
      <section>
        <h2>Access and ending use</h2>
        <p>
          Contact Apero to request account access changes or to discuss ending use of the service.
          The clinic should arrange any necessary export or transition of its records with Apero
          before access ends.
        </p>
      </section>
      <section>
        <h2>Service limitations</h2>
        <p>
          Software and external services can experience interruptions or errors. Clinics should
          review important bookings and call outcomes and maintain a practical way to handle urgent
          patient needs when the service is unavailable. Any commercial terms, warranties, and
          liability limits should be agreed in a separate signed agreement.
        </p>
      </section>
      <section>
        <h2>Owner review before launch</h2>
        <p>
          Confirm the contracting legal entity, governing law, commercial terms, support
          commitments, termination process, and any warranties or liability terms with legal counsel
          before treating this draft as final terms.
        </p>
      </section>
    </LegalPage>
  );
}
