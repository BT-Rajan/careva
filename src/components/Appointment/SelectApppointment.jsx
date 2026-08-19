import { Button, Empty, Spin } from 'antd';
import moment from 'moment';
import { FaBriefcase, FaRegClock, FaLocationArrow, FaLink, FaCalendarAlt } from 'react-icons/fa';
import { useGetAppointmentTimeQuery } from '../../redux/api/timeSlotApi';
import './AppointmentFlow.css';
import './index.css';

// Pass 11 — Doctor Schedule Engine.
//
// This component previously rendered a hardcoded, doctor-agnostic list of times from
// src/constant/global.js — the SAME 17 slots (8am-5pm, skipping lunch) for every doctor,
// regardless of that doctor's actual configured hours, existing bookings, or blocked
// dates. It never called the real schedule engine at all. Patients booking through this
// flow (the primary, self-service booking path) could pick a time a given doctor never
// configured, or one that was already fully booked, and only find out it was invalid
// when the booking submission itself was rejected server-side.
//
// Now calls the same getAppointmentTimeOfEachDoctor endpoint the doctor-assisted booking
// flow (Booking/DoctorBooking/DoctorBooking.jsx) already correctly used — with the actual
// selected date, so the backend's availability recalculation (Pass 11) can also filter
// out already-at-capacity slots and blocked dates, not just theoretically-configured hours.
const SelectApppointment = ({ selectedDate, handleDateChange, selectTime, setSelectTime, selectedDoctor }) => {
  const handleSelectTime = (time) => setSelectTime(time);

  const next7Days = Array.from({ length: 7 }, (_, i) => moment().clone().add(i + 1, 'days'));

  const selectedDay = selectedDate ? moment(selectedDate).format('dddd').toLowerCase() : undefined;

  const { data: timeData, isLoading: isLoadingTimes, isFetching: isFetchingTimes } = useGetAppointmentTimeQuery(
    { day: selectedDay, date: selectedDate, id: selectedDoctor?.id },
    { skip: !selectedDoctor?.id || !selectedDate }
  );

  // RTK Query's axiosBaseQuery + response interceptor already unwrap to the inner data
  // directly (confirmed against Booking/DoctorBooking/DoctorBooking.jsx's existing,
  // working use of this same query — it maps over the hook's `data` directly, not
  // `data.data`), so `timeData` here IS the array, not a wrapper object.
  const availableSlots = Array.isArray(timeData) ? timeData : [];
  const amTimeSlot = availableSlots.filter((item) => item?.slot?.time?.toLowerCase().includes('am'));
  const pmTimeSlot = availableSlots.filter((item) => item?.slot?.time?.toLowerCase().includes('pm'));

  const fullName = selectedDoctor
    ? `Dr. ${(selectedDoctor.firstName || '')} ${(selectedDoctor.lastName || '')}`.trim() || 'Doctor'
    : 'Doctor';

  return (
    <div className="appointment-step appointment-step--datetime">
      <p className="appointment-step__title">Select date & time</p>
      <p className="appointment-step__subtitle">Pick an available slot for your appointment.</p>

      <div className="datetime-summary">
        <div className="datetime-summary__row">
          <FaBriefcase className="icon" />
          <span className="datetime-summary__label">Doctor</span>
          <span className="datetime-summary__value">{fullName}</span>
        </div>
        <div className="datetime-summary__row">
          <FaRegClock className="icon" />
          <span className="datetime-summary__label">Duration</span>
          <span className="datetime-summary__value">30 min</span>
        </div>
        <div className="datetime-summary__row">
          <FaLocationArrow className="icon" />
          <span className="datetime-summary__label">Location</span>
          <span className="datetime-summary__value">Chennai, India · Zoom Meeting</span>
        </div>
        {(selectedDate || selectTime) && (
          <div className="datetime-summary__row">
            <FaCalendarAlt className="icon" />
            <span className="datetime-summary__label">Selected</span>
            <span className="datetime-summary__value">
              {selectedDate && moment(selectedDate).format('LL')}
              {selectTime && ` · ${selectTime}`}
            </span>
          </div>
        )}
      </div>

      <p className="appointment-step__subtitle" style={{ marginBottom: '0.5rem' }}>
        {selectedDate ? `Selected date: ${moment(selectedDate).format('LL')}` : 'Pick a date'}
      </p>
      <div className="datetime-dates">
        {next7Days.map((day) => {
          const isActive =
            selectedDate && moment(selectedDate).format('YYYY-MM-DD') === day.format('YYYY-MM-DD');
          return (
            <div
              key={day.valueOf()}
              className={`datetime-date-card ${isActive ? 'datetime-date-card--active' : ''}`}
              onClick={() => handleDateChange(day)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && handleDateChange(day)}
              aria-pressed={isActive}
            >
              <div className="day-num">{day.format('D')}</div>
              <div className="month-year">{day.format('MMM YYYY')}</div>
              <div className="weekday">{day.format('dddd')}</div>
            </div>
          );
        })}
      </div>

      <p className="appointment-step__subtitle" style={{ marginBottom: '0.5rem' }}>
        {selectTime
          ? `Selected: ${selectTime} – ${moment(selectTime, 'hh:mm A').add(30, 'minutes').format('hh:mm A')}`
          : 'Pick a time'}
      </p>

      {!selectedDate && (
        <Empty description="Pick a date above to see available times" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}

      {selectedDate && (isLoadingTimes || isFetchingTimes) && (
        <div style={{ textAlign: 'center', padding: '1.5rem' }}>
          <Spin />
        </div>
      )}

      {selectedDate && !isLoadingTimes && !isFetchingTimes && availableSlots.length === 0 && (
        <Empty description="This doctor has no available times on the selected date" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}

      {selectedDate && !isLoadingTimes && !isFetchingTimes && amTimeSlot.length > 0 && (
        <div className="datetime-times-section">
          <h4>Morning</h4>
          <div>
            {amTimeSlot.map((item) => (
              <Button
                key={item.slot.id}
                type={item.slot.time === selectTime ? 'primary' : 'default'}
                size="small"
                onClick={() => handleSelectTime(item.slot.time)}
              >
                {item.slot.time}
              </Button>
            ))}
          </div>
        </div>
      )}
      {selectedDate && !isLoadingTimes && !isFetchingTimes && pmTimeSlot.length > 0 && (
        <div className="datetime-times-section">
          <h4>Afternoon / Evening</h4>
          <div>
            {pmTimeSlot.map((item) => (
              <Button
                key={item.slot.id}
                type={item.slot.time === selectTime ? 'primary' : 'default'}
                size="small"
                onClick={() => handleSelectTime(item.slot.time)}
              >
                {item.slot.time}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default SelectApppointment;
