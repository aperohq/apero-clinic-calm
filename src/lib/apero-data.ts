export type Status = "Booked" | "Completed" | "Needs Review" | "Missed" | "Cancelled";

export const staff = [
  { id: "ahmed-qandil", name: "Dr. Ahmed Qandil", initials: "AQ", specialty: "General Dentistry", role: "Clinic Owner", phone: "+965 2225 4100", email: "ahmed.qandil@dentalzone.com", services: ["Dental Cleaning", "Consultation", "Root Canal"] },
  { id: "mohammed-shuqeir", name: "Dr. Mohammed Shuqeir", initials: "MS", specialty: "Cosmetic Dentistry", role: "Dentist", phone: "+965 2225 4101", email: "mohammed@dentalzone.com", services: ["Veneers Consultation", "Teeth Whitening"] },
  { id: "fatima-hassan", name: "Dr. Fatima Hassan", initials: "FH", specialty: "Orthodontics", role: "Orthodontist", phone: "+965 2225 4102", email: "fatima@dentalzone.com", services: ["Orthodontic Consultation", "Braces Review"] },
  { id: "layla-salem", name: "Layla Salem", initials: "LS", specialty: "Dental Hygiene", role: "Dental Hygienist", phone: "+965 2225 4103", email: "layla@dentalzone.com", services: ["Dental Cleaning", "Preventive Care"] },
];

export const clients = [
  { id: "sarah-al-hamad", name: "Sarah Al-Hamad", initials: "SA", phone: "+965 9912 3456", email: "sarah.hamad@example.com", language: "English", status: "Active Patient", bookings: 5, lastContact: "3 hours ago" },
  { id: "mohamed-mahmoud", name: "Mohamed Mahmoud", initials: "MM", phone: "+965 9587 4568", email: "m.mahmoud@example.com", language: "Arabic", status: "Active Patient", bookings: 3, lastContact: "2 days ago" },
  { id: "fatima-alkandari", name: "Fatima Al-Kandari", initials: "FK", phone: "+965 9443 2190", email: "f.alkandari@example.com", language: "Arabic", status: "Active Patient", bookings: 2, lastContact: "Sep 8" },
  { id: "tariq-mansour", name: "Tariq Mansour", initials: "TM", phone: "+965 6658 7701", email: "tariq.m@example.com", language: "English", status: "New Client", bookings: 1, lastContact: "Sep 7" },
  { id: "noura-al-sabah", name: "Noura Al-Sabah", initials: "NS", phone: "+965 9771 8004", email: "noura.s@example.com", language: "English", status: "Active Patient", bookings: 4, lastContact: "Sep 5" },
];

export const appointments = [
  { id: "apt-1", clientId: "sarah-al-hamad", staffId: "ahmed-qandil", date: "2026-09-14", day: "Mon", time: "10:30 AM", duration: "45 min", service: "Dental Cleaning", chair: "Chair 2", status: "Booked" as Status, source: "Booked by Apero" },
  { id: "apt-2", clientId: "mohamed-mahmoud", staffId: "layla-salem", date: "2026-09-16", day: "Wed", time: "9:00 AM", duration: "45 min", service: "Dental Cleaning", chair: "Chair 1", status: "Booked" as Status, source: "Booked by Apero" },
  { id: "apt-3", clientId: "fatima-alkandari", staffId: "fatima-hassan", date: "2026-09-15", day: "Tue", time: "1:00 PM", duration: "60 min", service: "Orthodontic Consultation", chair: "Chair 3", status: "Booked" as Status, source: "Front desk" },
  { id: "apt-4", clientId: "noura-al-sabah", staffId: "mohammed-shuqeir", date: "2026-09-17", day: "Thu", time: "3:30 PM", duration: "45 min", service: "Veneers Consultation", chair: "Chair 2", status: "Booked" as Status, source: "Booked by Apero" },
];

export const conversations = [
  { id: "9941", clientId: "sarah-al-hamad", date: "Sep 13, 2026", time: "10:34 AM", duration: "2m 15s", reason: "Appointment Booking Call", status: "Booked" as Status, summary: "Sarah called to schedule a dental cleaning. Apero confirmed her details, checked real-time availability, and booked an appointment with Dr. Ahmed Qandil for Monday, September 14 at 10:30 AM." },
  { id: "9938", clientId: "mohamed-mahmoud", date: "Sep 13, 2026", time: "9:12 AM", duration: "1m 48s", reason: "Clinic Hours & Cleaning", status: "Booked" as Status, summary: "Mohamed asked about clinic hours and booked a cleaning." },
  { id: "9932", clientId: "fatima-alkandari", date: "Sep 12, 2026", time: "4:44 PM", duration: "3m 02s", reason: "Treatment Follow-up", status: "Needs Review" as Status, summary: "Fatima requested a call back about her orthodontic treatment plan." },
  { id: "9927", clientId: "tariq-mansour", date: "Sep 12, 2026", time: "2:06 PM", duration: "0m 34s", reason: "Missed Call", status: "Missed" as Status, summary: "The caller disconnected before a request was collected." },
  { id: "9919", clientId: "noura-al-sabah", date: "Sep 11, 2026", time: "11:30 AM", duration: "2m 21s", reason: "Veneers Consultation", status: "Booked" as Status, summary: "Noura booked a veneers consultation with Dr. Mohammed." },
];

export const invoices = [
  { id: "APR-2026-0913", date: "Sep 13, 2026", description: "Apero Monthly Subscription", amount: "$—", status: "Paid" },
  { id: "APR-2026-0813", date: "Aug 13, 2026", description: "Apero Monthly Subscription", amount: "$—", status: "Paid" },
  { id: "APR-2026-0713", date: "Jul 13, 2026", description: "Apero Monthly Subscription", amount: "$—", status: "Paid" },
];

export const transcript = [
  ["Apero Receptionist", "Good morning, thank you for calling Dental Zone Clinic. How can I help you today?", "00:01"],
  ["Sarah Al-Hamad", "Hi, I'd like to book an appointment for a routine dental cleaning.", "00:07"],
  ["Apero Receptionist", "Of course! What day and time works best for you?", "00:13"],
  ["Sarah Al-Hamad", "Next Monday morning if possible, with Dr. Ahmed.", "00:20"],
  ["Apero Receptionist", "Dr. Ahmed has an opening next Monday, September 14th at 10:30 AM. Would that suit your schedule?", "00:26"],
  ["Sarah Al-Hamad", "Yes, that works perfectly.", "00:35"],
  ["Apero Receptionist", "Wonderful. May I confirm your full name and phone number?", "00:38"],
  ["Sarah Al-Hamad", "Sarah Al-Hamad, +965 9912 3456.", "00:43"],
  ["Apero Receptionist", "Thank you, Sarah. You are confirmed for Monday, Sep 14 at 10:30 AM. A confirmation message has been sent.", "00:50"],
] as const;

export function clientById(id: string) { return clients.find((client) => client.id === id); }
export function staffById(id: string) { return staff.find((person) => person.id === id); }
export function conversationById(id: string) { return conversations.find((conversation) => conversation.id === id); }
